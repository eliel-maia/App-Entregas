if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(() => console.log('Service Worker OK'))
      .catch(err => console.log('Erro SW:', err));
  });
}

let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  document.getElementById('btn-install').style.display = 'flex';
});

function triggerInstall() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then((choiceResult) => {
      if (choiceResult.outcome === 'accepted') {
        document.getElementById('btn-install').style.display = 'none';
      }
      deferredPrompt = null;
    });
  } else {
    alert("Para instalar:\n\n• No Android (Chrome): Toque nos 3 pontos e escolha 'Adicionar à tela inicial'.\n• No iPhone (Safari): Toque em Compartilhar e 'Adicionar à Tela de Início'.");
  }
}

let stopsData = [];
let currentIndex = 0;
let map = null;
let markers = [];
let userMarker = null;
let userLocation = null;
let routeStartTime = null;
let routeEndTime = null;

function saveDataToStorage() {
  try {
    localStorage.setItem('delivery_stops_data', JSON.stringify(stopsData));
    localStorage.setItem('delivery_current_index', currentIndex.toString());
    if (routeStartTime) localStorage.setItem('delivery_route_start_time', routeStartTime.toString());
    if (routeEndTime) localStorage.setItem('delivery_route_end_time', routeEndTime.toString());
  } catch (e) {
    console.error("Erro ao salvar no storage:", e);
  }
}

function loadDataFromStorage() {
  try {
    const savedStops = localStorage.getItem('delivery_stops_data');
    const savedIndex = localStorage.getItem('delivery_current_index');
    const savedStartTime = localStorage.getItem('delivery_route_start_time');
    const savedEndTime = localStorage.getItem('delivery_route_end_time');
    if (savedStops) {
      stopsData = JSON.parse(savedStops);
      currentIndex = savedIndex ? parseInt(savedIndex, 10) : 0;
      if (savedStartTime) routeStartTime = parseInt(savedStartTime, 10);
      if (savedEndTime) routeEndTime = parseInt(savedEndTime, 10);
      return true;
    }
  } catch (e) {
    console.error("Erro ao carregar do storage:", e);
  }
  return false;
}

function extractStreetName(fullAddress) {
  if (!fullAddress) return '';
  let base = fullAddress.split(',')[0].split('-')[0];
  let clean = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const prefixes = [
    /^rua\b\s*/, /^r\.\s*/, /^r\b\s*/,
    /^avenida\b\s*/, /^av\.\s*/, /^av\b\s*/,
    /^alameda\b\s*/, /^alm\.\s*/,
    /^travessa\b\s*/, /^tv\.\s*/,
    /^praca\b\s*/, /^pca\.\s*/,
    /^rodovia\b\s*/, /^rod\.\s*/
  ];

  for (let p of prefixes) {
    clean = clean.replace(p, '');
  }

  clean = clean.replace(/[0-9]/g, '').replace(/[^a-z0-9\s]/g, '').trim();
  return clean;
}

function normalizeAddressForGrouping(fullAddress) {
  if (!fullAddress) return '';
  let norm = fullAddress.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  let parts = norm.split(',');
  let street = extractStreetName(parts[0] || '');
  let number = '';
  if (parts.length > 1) {
    let match = parts[1].match(/\d+/);
    if (match) number = match[0];
  }
  return `${street}_${number}`;
}

function calculateDistanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const meanLat = ((lat1 + lat2) / 2) * rad;
  const x = dLon * Math.cos(meanLat);
  const y = dLat;
  return Math.sqrt(x * x + y * y) * R;
}

function calculateRemainingTime() {
  const pendingStopsCount = stopsData.filter(s => s.status === 'pending').length;
  const totalMinutes = pendingStopsCount * 4;
  if (totalMinutes === 0) return '0m';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function calculateTotalElapsedTime() {
  if (!routeStartTime) return '0m';
  const endTime = routeEndTime || Date.now();
  const diffMs = endTime - routeStartTime;
  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  let parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function optimizeRouteSequential() {
  if (stopsData.length <= 1) return;
  let centerLat = stopsData.reduce((s, p) => s + p.lat, 0) / stopsData.length;
  let centerLng = stopsData.reduce((s, p) => s + p.lng, 0) / stopsData.length;
  let startIdx = 0, maxDist = -1;
  stopsData.forEach((p, idx) => {
    let d = calculateDistanceInMeters(p.lat, p.lng, centerLat, centerLng);
    if (d > maxDist) { maxDist = d; startIdx = idx; }
  });
  let unvisited = [...stopsData];
  let current = unvisited.splice(startIdx, 1)[0];
  let ordered = [current];
  while (unvisited.length > 0) {
    let bestIdx = 0, minCost = Infinity;
    for (let i = 0; i < unvisited.length; i++) {
      let dist = calculateDistanceInMeters(current.lat, current.lng, unvisited[i].lat, unvisited[i].lng);
      if (dist < minCost) { minCost = dist; bestIdx = i; }
    }
    current = unvisited.splice(bestIdx, 1)[0];
    ordered.push(current);
  }
  stopsData = ordered;
  currentIndex = 0;
  saveDataToStorage();
}

function isMapCanvasHealthy() {
  if (!map) return false;
  try {
    const canvas = map.getCanvas();
    if (!canvas) return false;
    if (canvas.width === 0 || canvas.height === 0) return false;
    
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl && gl.isContextLost()) return false;

    return true;
  } catch (e) {
    return false;
  }
}

function initMap() {
  if (map) {
    try { 
      markers.forEach(m => m.remove());
      markers = [];
      if (userMarker) userMarker.remove();
      userMarker = null;
      map.remove(); 
    } catch (e) {
      console.warn("Aviso ao limpar instância antiga do mapa:", e);
    }
    map = null;
  }

  const defaultCenter = (stopsData.length > 0 && stopsData[currentIndex]) 
    ? [stopsData[currentIndex].lng, stopsData[currentIndex].lat] 
    : [-49.653, -22.222];

  map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.stadiamaps.com/styles/alidade_smooth.json',
    center: defaultCenter,
    zoom: 14,
    trackResize: true
  });

  setupMapRecovery();

  map.on('load', () => {
    const hasData = loadDataFromStorage();
    renderStops(hasData);
    startLiveTracking();
  });
}

function setupMapRecovery() {
  if (!map) return;
  const mapCanvas = map.getCanvas();

  mapCanvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    console.warn('Perda de contexto WebGL detectada ao alternar de aplicativo.');
  }, false);

  mapCanvas.addEventListener('webglcontextrestored', () => {
    console.log('Contexto WebGL restaurado pelo SO. Reinicializando mapa...');
    setTimeout(() => initMap(), 200);
  }, false);
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible') {
    setTimeout(() => {
      if (!isMapCanvasHealthy()) {
        console.log("Mapa corrompido ou contexto WebGL perdido. Reinicializando mapa...");
        initMap();
      } else {
        console.log("Mapa saudável. Redimensionando e redesenhando...");
        map.resize();
        map.triggerRepaint();
        if (stopsData[currentIndex]) {
          map.setCenter([stopsData[currentIndex].lng, stopsData[currentIndex].lat]);
        }
      }
    }, 300);
  }
}

document.addEventListener('visibilitychange', handleVisibilityChange);
window.addEventListener('pageshow', handleVisibilityChange);
window.addEventListener('focus', handleVisibilityChange);

function startLiveTracking() {
  if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition((position) => {
      const lat = position.coords.latitude;
      const lng = position.coords.longitude;
      userLocation = [lng, lat];

      if (!map || !isMapCanvasHealthy()) return;

      if (userMarker) {
        userMarker.setLngLat(userLocation);
      } else {
        const el = document.createElement('div');
        el.className = 'gps-pin-container';
        el.innerHTML = '<div class="gps-marker-ring"><div class="gps-marker-inner"></div></div>';

        userMarker = new maplibregl.Marker({ element: el })
          .setLngLat(userLocation)
          .addTo(map);
      }
    }, (error) => {
      console.log("Erro no GPS: ", error.message);
    }, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 10000
    });
  }
}

function centerOnUserGPS() {
  if (!map || !isMapCanvasHealthy()) return;
  if (userLocation) {
    map.flyTo({ center: userLocation, zoom: 15 });
  } else {
    navigator.geolocation.getCurrentPosition((position) => {
      userLocation = [position.coords.longitude, position.coords.latitude];
      map.flyTo({ center: userLocation, zoom: 15 });
    }, () => {
      alert("Não foi possível obter sua localização atual. Verifique se o GPS está ativado.");
    }, { enableHighAccuracy: true });
  }
}

function selectNearestStopToUser() {
  if (stopsData.length === 0) return;

  const processSelection = (uLng, uLat) => {
    let bestIndex = -1;
    let minDistance = Infinity;

    stopsData.forEach((stop, index) => {
      if (stop.status === 'pending' && typeof stop.lat === 'number' && typeof stop.lng === 'number' && !isNaN(stop.lat)) {
        const dist = calculateDistanceInMeters(uLat, uLng, stop.lat, stop.lng);
        if (dist < minDistance) {
          minDistance = dist;
          bestIndex = index;
        }
      }
    });

    if (bestIndex !== -1) {
      selectStop(bestIndex);
    } else {
      alert("Nenhuma parada pendente foi encontrada.");
    }
  };

  if (userLocation) {
    processSelection(userLocation[0], userLocation[1]);
  } else if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        userLocation = [position.coords.longitude, position.coords.latitude];
        processSelection(userLocation[0], userLocation[1]);
      },
      () => {
        alert("Não foi possível obter sua localização atual para identificar a parada mais próxima.");
      },
      { enableHighAccuracy: true }
    );
  } else {
    alert("Geolocalização não suportada neste dispositivo.");
  }
}

function renderStops(fitMapBounds = false) {
  if (!map || !isMapCanvasHealthy()) return;
  
  markers.forEach(m => m.remove());
  markers = [];

  const bounds = new maplibregl.LngLatBounds();

  stopsData.forEach((item, index) => {
    if (typeof item.lat === 'number' && typeof item.lng === 'number' && !isNaN(item.lat)) {
      const lngLat = [item.lng, item.lat];
      bounds.extend(lngLat);

      const isActive = index === currentIndex;
      let statusClass = '';
      if (item.status === 'delivered') statusClass = 'done';
      if (item.status === 'failed') statusClass = 'failed';
      
      const badgeHtml = item.packagesCount > 1 ? `<div class="pkg-badge">${item.packagesCount}</div>` : '';
      
      const el = document.createElement('div');
      el.className = 'custom-pin-container';
      el.innerHTML = `
        <div class="custom-pin-wrapper">
          <div class="custom-pin ${isActive ? 'active' : ''} ${statusClass}">
            ${item.originalStop || (index+1)}
            ${badgeHtml}
          </div>
        </div>
      `;

      el.addEventListener('click', () => {
        selectStop(index);
      });

      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat(lngLat)
        .addTo(map);

      markers.push(marker);
    }
  });

  if (fitMapBounds && stopsData.length > 0) {
    map.fitBounds(bounds, { padding: 50, maxZoom: 15 });
  }

  updateUI();
}

function selectStop(index) {
  if (stopsData.length === 0) return;
  currentIndex = index;
  saveDataToStorage();
  const stop = stopsData[currentIndex];
  if (stop && !isNaN(stop.lat) && map && isMapCanvasHealthy()) {
    map.flyTo({ center: [stop.lng, stop.lat], zoom: 16 });
  }
  renderStops(false);
}

function setDeliveryStatus(status) {
  if (stopsData.length === 0) return;

  if (!routeStartTime) {
    routeStartTime = Date.now();
  }

  const currentStop = stopsData[currentIndex];
  currentStop.status = status;

  const currentStreet = extractStreetName(currentStop.address);

  let allPendingWithDist = stopsData
    .map((s, idx) => {
      const streetCandidate = extractStreetName(s.address);
      const isSameStreet = (streetCandidate !== '' && currentStreet !== '') && (streetCandidate === currentStreet);
      const distMeters = calculateDistanceInMeters(currentStop.lat, currentStop.lng, s.lat, s.lng);
      return { stop: s, index: idx, distMeters, isSameStreet };
    })
    .filter(item => item.stop.status === 'pending');

  let nextIndex = -1;

  let sameStreetNearby = allPendingWithDist.filter(item => item.isSameStreet && item.distMeters <= 300);

  if (sameStreetNearby.length > 0) {
    sameStreetNearby.sort((a, b) => a.distMeters - b.distMeters);
    nextIndex = sameStreetNearby[0].index;
  } else {
    let blockNearby = allPendingWithDist.filter(item => item.distMeters <= 250);

    if (blockNearby.length > 0) {
      blockNearby.sort((a, b) => a.distMeters - b.distMeters);
      nextIndex = blockNearby[0].index;
    } else if (allPendingWithDist.length > 0) {
      allPendingWithDist.sort((a, b) => a.distMeters - b.distMeters);
      nextIndex = allPendingWithDist[0].index;
    } else {
      nextIndex = stopsData.findIndex(s => s.status === 'pending');
    }
  }

  if (allPendingWithDist.length === 0) {
    if (!routeEndTime) {
      routeEndTime = Date.now();
    }
  }

  if (nextIndex !== -1) currentIndex = nextIndex;
  saveDataToStorage();
  renderStops(false);
  
  const activeStop = stopsData[currentIndex];
  if (activeStop && !isNaN(activeStop.lat) && map && isMapCanvasHealthy()) {
    map.flyTo({ center: [activeStop.lng, activeStop.lat], zoom: 16 });
  }
}

function updateUI() {
  const tagsRow = document.getElementById('tags-row');
  const actionsContainer = document.getElementById('actions-container');

  if (stopsData.length === 0) {
    document.getElementById('time-val').innerText = '0m';
    document.getElementById('delivered-pkgs').innerText = '0';
    document.getElementById('total-pkgs').innerText = '0';
    tagsRow.style.setProperty('display', 'none', 'important');
    document.getElementById('address-title').innerText = 'AGUARDANDO PLANILHA';
    document.getElementById('address-subtitle').innerText = 'Abra o menu e carregue o arquivo';
    
    actionsContainer.innerHTML = `
      <label for="excel-upload" class="btn-start-route" style="flex:1; margin:0; cursor:pointer;">
        <i class="fa-solid fa-file-excel"></i> CARREGAR PLANILHA
      </label>
    `;
    renderList();
    return;
  }

  let totalPkgs = 0, deliveredPkgs = 0;
  stopsData.forEach(s => {
    totalPkgs += s.packagesCount;
    if (s.status === 'delivered') deliveredPkgs += s.packagesCount;
  });

  document.getElementById('time-val').innerText = calculateRemainingTime();
  document.getElementById('delivered-pkgs').innerText = deliveredPkgs;
  document.getElementById('total-pkgs').innerText = totalPkgs;

  const pendingCount = stopsData.filter(s => s.status === 'pending').length;

  if (pendingCount === 0) {
    if (!routeEndTime) routeEndTime = Date.now();
    tagsRow.style.setProperty('display', 'none', 'important');
    
    document.getElementById('address-title').innerText = '🎉 ROTA FINALIZADA!';
    document.getElementById('address-subtitle').innerText = `Tempo total percorrido: ${calculateTotalElapsedTime()}`;

    actionsContainer.innerHTML = `
      <label for="excel-upload" class="btn-start-route" style="flex:1; margin:0; cursor:pointer;">
        <i class="fa-solid fa-file-excel"></i> CARREGAR PLANILHA
      </label>
    `;
    renderList();
    return;
  }

  tagsRow.style.setProperty('display', 'flex', 'important');
  const stop = stopsData[currentIndex] || stopsData[0];

  const totalCount = stopsData.length;
  const completedCount = stopsData.filter(s => s.status === 'delivered' || s.status === 'failed').length;

  let currentStepDisplay;
  if (stop.status === 'delivered' || stop.status === 'failed') {
    currentStepDisplay = completedCount;
  } else {
    currentStepDisplay = completedCount + 1;
  }

  document.getElementById('current-step-num').innerText = currentStepDisplay;
  document.getElementById('total-step-num').innerText = totalCount;
  
  document.getElementById('tag-stop').innerHTML = `PARADA&nbsp;${stop.originalStop}`;

  document.getElementById('tag-packages').innerText = `${stop.packagesCount} PACOTE(S)`;
  document.getElementById('address-title').innerText = stop.address;
  document.getElementById('address-subtitle').innerText = `${stop.neighborhood}, ${stop.city}`;

  const wazeUrl = `https://waze.com/ul?ll=${stop.lat},${stop.lng}&navigate=yes`;

  actionsContainer.innerHTML = `
    <a href="${wazeUrl}" target="_blank" class="btn-waze-blue"><i class="fa-solid fa-location-arrow" style="font-size:14px;"></i><span>WAZE</span></a>
    <button class="btn-fail" onclick="setDeliveryStatus('failed')"><i class="fa-solid fa-box-archive" style="font-size:14px;"></i><span>FALHA</span></button>
    <button class="btn-success" onclick="setDeliveryStatus('delivered')"><i class="fa-solid fa-box-check" style="font-size:14px;"></i><span>ENTREGUE</span></button>
  `;
  
  renderList();
}

function toggleModal(modalId, show) {
  document.getElementById(modalId).className = show ? 'modal active' : 'modal';
}

function openPackagesModal() {
  if (stopsData.length === 0) return;
  const stop = stopsData[currentIndex];

  const listContainer = document.getElementById('packages-list');
  listContainer.innerHTML = '';

  let itemClass = '';
  if (stop.status === 'delivered') itemClass = 'completed';
  else if (stop.status === 'failed') itemClass = 'failed';

  let packagesHtml = '';
  stop.packagesList.forEach(pkg => {
    packagesHtml += `
      <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #f1f5f9; display: flex; align-items: center; justify-content: space-between;">
        <div>
          <span class="stop-badge" style="background:#5046e5;">PARADA ${pkg.stopNumber}</span>
          <div style="font-size: 13px; font-weight: 800; color: #0f172a; margin-top: 4px;">${pkg.code}</div>
        </div>
        <i class="fa-solid fa-barcode" style="font-size: 20px; color: #5046e5;"></i>
      </div>
    `;
  });

  const card = document.createElement('div');
  card.className = `stop-item ${itemClass}`;
  card.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px;">
      <div>
        <div style="font-size: 13px; font-weight: 700; color: #111827; text-transform: uppercase;">${stop.address}</div>
        <div style="font-size: 11px; color: #6b7280;">${stop.neighborhood}${stop.city ? ' - ' + stop.city : ''}</div>
      </div>
      <div>
        ${stop.status === 'delivered' ? '<i class="fa-solid fa-circle-check" style="color:#10b981; font-size:16px;"></i>' : (stop.status === 'failed' ? '<i class="fa-solid fa-circle-xmark" style="color:#ef4444; font-size:16px;"></i>' : '<i class="fa-regular fa-circle" style="color:#cbd5e1; font-size:16px;"></i>')}
      </div>
    </div>
    ${packagesHtml}
  `;

  listContainer.appendChild(card);
  toggleModal('pacotes-modal', true);
}

function renderList() {
  const listContainer = document.getElementById('stops-list');
  listContainer.innerHTML = '';
  
  if (stopsData.length === 0) {
    listContainer.innerHTML = '<div style="text-align:center; padding: 20px; color:#6b7280; font-size:12px;">Nenhuma rota carregada no momento. Carregue uma planilha acima.</div>';
    return;
  }

  const sortedStops = [...stopsData].sort((a, b) => {
    const isPlusA = String(a.originalStop).trim().startsWith('+');
    const isPlusB = String(b.originalStop).trim().startsWith('+');
    const numA = parseInt(String(a.originalStop).replace(/[^0-9]/g, '')) || 0;
    const numB = parseInt(String(b.originalStop).replace(/[^0-9]/g, '')) || 0;

    if (isPlusA && !isPlusB) return -1;
    if (!isPlusA && isPlusB) return 1;

    return numA - numB;
  });

  sortedStops.forEach((item) => {
    const originalIndex = stopsData.findIndex(s => s.id === item.id);
    let itemClass = '';
    if (item.status === 'delivered') itemClass = 'completed';
    else if (item.status === 'failed') itemClass = 'failed';

    let packagesHtml = '';
    item.packagesList.forEach(pkg => {
      packagesHtml += `
        <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid #f1f5f9; display: flex; align-items: center; justify-content: space-between;">
          <div>
            <span class="stop-badge" style="background:#5046e5;">PARADA ${pkg.stopNumber}</span>
            <div style="font-size: 13px; font-weight: 800; color: #0f172a; margin-top: 4px;">${pkg.code}</div>
          </div>
          <i class="fa-solid fa-barcode" style="font-size: 20px; color: #5046e5;"></i>
        </div>
      `;
    });

    const div = document.createElement('div');
    div.className = `stop-item ${itemClass}`;
    div.onclick = () => { selectStop(originalIndex); toggleModal('paradas-modal', false); };
    
    div.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 4px;">
        <div>
          <div style="font-size: 13px; font-weight: 700; color: #111827; text-transform: uppercase;">${item.address}</div>
          <div style="font-size: 11px; color: #6b7280;">${item.neighborhood}${item.city ? ' - ' + item.city : ''}</div>
        </div>
        <div>
          ${item.status === 'delivered' ? '<i class="fa-solid fa-circle-check" style="color:#10b981; font-size:16px;"></i>' : (item.status === 'failed' ? '<i class="fa-solid fa-circle-xmark" style="color:#ef4444; font-size:16px;"></i>' : '<i class="fa-regular fa-circle" style="color:#cbd5e1; font-size:16px;"></i>')}
        </div>
      </div>
      ${packagesHtml}
    `;
    listContainer.appendChild(div);
  });
}

function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(sheet);
    const stopsMap = new Map();
    
    let extraStopCounter = 0;
    const unnumberedAddressMap = new Map();

    const validCoordsByAddress = new Map();
    json.forEach(row => {
      let rawLat = String(row['Latitude'] || '').replace(',', '.').trim();
      let rawLng = String(row['Longitude'] || '').replace(',', '.').trim();
      let lat = parseFloat(rawLat);
      let lng = parseFloat(rawLng);

      if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
        const fullAddr = String(row['Destination Address'] || '').trim().toLowerCase();
        const streetName = extractStreetName(fullAddr);
        
        if (!validCoordsByAddress.has(fullAddr)) {
          validCoordsByAddress.set(fullAddr, { lat, lng });
        }
        if (streetName && !validCoordsByAddress.has(streetName)) {
          validCoordsByAddress.set(streetName, { lat, lng });
        }
      }
    });

    json.forEach((row, index) => {
      let rawLat = String(row['Latitude'] || '').replace(',', '.').trim();
      let rawLng = String(row['Longitude'] || '').replace(',', '.').trim();
      
      let lat = parseFloat(rawLat);
      let lng = parseFloat(rawLng);

      let isValidCoords = !isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0;
      const fullAddress = String(row['Destination Address'] || '').trim();
      const streetName = extractStreetName(fullAddress);
      const normalizedAddress = normalizeAddressForGrouping(fullAddress);

      if (!isValidCoords) {
        const foundCoords = validCoordsByAddress.get(fullAddress.toLowerCase()) || validCoordsByAddress.get(streetName);
        if (foundCoords) {
          lat = foundCoords.lat;
          lng = foundCoords.lng;
          isValidCoords = true;
        } else {
          lat = -22.2223;
          lng = -49.6531;
        }
      }

      const rawStopVal = row['Stop'] !== undefined && row['Stop'] !== null ? String(row['Stop']).trim() : '';
      const isNumbered = rawStopVal !== '' && rawStopVal !== '-' && !isNaN(parseInt(rawStopVal, 10));

      const locationKey = normalizedAddress !== '_' 
        ? `ADDR_${normalizedAddress}`
        : (isValidCoords ? `POS_${lat.toFixed(5)}_${lng.toFixed(5)}` : `INDEX_${index}`);

      let rawStop = '';

      if (isNumbered) {
        rawStop = rawStopVal;
      } else {
        if (unnumberedAddressMap.has(locationKey)) {
          rawStop = unnumberedAddressMap.get(locationKey);
        } else {
          extraStopCounter++;
          rawStop = `+${extraStopCounter}`;
          unnumberedAddressMap.set(locationKey, rawStop);
        }
      }

      const key = locationKey;
      const spxCode = row['SPX TN'] || `VOL-${index + 1}`;

      if (stopsMap.has(key)) {
        let existing = stopsMap.get(key);
        existing.packagesCount += 1;
        existing.packagesList.push({ 
          stopNumber: rawStop, 
          code: spxCode 
        });
        if (!existing.stopsList.includes(rawStop)) {
          existing.stopsList.push(rawStop);
          existing.stopsList.sort((a, b) => {
            const numA = parseInt(String(a).replace(/[^0-9]/g, '')) || 0;
            const numB = parseInt(String(b).replace(/[^0-9]/g, '')) || 0;
            return numA - numB;
          });
          existing.originalStop = existing.stopsList[0];
        }
        if (fullAddress && fullAddress.length < existing.address.length) {
          existing.address = fullAddress;
        }
      } else {
        stopsMap.set(key, {
          id: key, 
          originalStop: rawStop, 
          stopsList: [rawStop],
          address: fullAddress || 'Endereço sem nome', 
          neighborhood: row['Bairro'] || '', 
          city: row['City'] || '',
          packagesCount: 1, 
          packagesList: [{ 
            stopNumber: rawStop, 
            code: spxCode 
          }], 
          lat: lat, 
          lng: lng, 
          status: 'pending'
        });
      }
    });

    const newStops = Array.from(stopsMap.values());
    if (newStops.length > 0) {
      stopsData = newStops;
      routeStartTime = null;
      routeEndTime = null;
      localStorage.removeItem('delivery_route_start_time');
      localStorage.removeItem('delivery_route_end_time');
      optimizeRouteSequential();
      renderStops(true);
      toggleModal('paradas-modal', false);
    } else {
      alert("Nenhum registro encontrado na planilha.");
    }
  };
  reader.readAsArrayBuffer(file);
}

window.onload = initMap;
