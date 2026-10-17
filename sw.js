/* ==========================================================================
   CONFIGURAÇÃO DO SERVICE WORKER (Cache e Ciclo de Vida PWA)
   ========================================================================== */
const CACHE_VERSION = 'v1.6.50'; // Atualize este valor ao modificar arquivos importantes para forçar atualização no cliente

// Evento de instalação: pula a espera e ativa imediatamente
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// Evento de ativação: limpa caches antigos que não correspondem à versão atual
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_VERSION) {
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Evento de fetch: tenta buscar na rede e recorre ao cache caso esteja offline
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});
