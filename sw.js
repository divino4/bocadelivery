// Service worker do Boca Delivery: rede primeiro (sempre pega a versão nova) e usa o cache se estiver sem internet.
var V='boca-v1';
self.addEventListener('install',function(e){e.waitUntil(caches.open(V).then(function(c){return c.addAll(['./','./index.html','./icon-192.png'])}).catch(function(){}));self.skipWaiting()});
self.addEventListener('activate',function(e){e.waitUntil(caches.keys().then(function(k){return Promise.all(k.filter(function(x){return x!==V}).map(function(x){return caches.delete(x)}))}));self.clients.claim()});
self.addEventListener('fetch',function(e){
  var r=e.request;
  if(r.method!=='GET'||new URL(r.url).origin!==location.origin)return; // Firebase e fontes passam direto
  e.respondWith(fetch(r).then(function(res){var c=res.clone();caches.open(V).then(function(x){x.put(r,c)});return res}).catch(function(){return caches.match(r).then(function(m){return m||caches.match('./index.html')})}));
});
