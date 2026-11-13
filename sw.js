self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{}}catch(x){d={body:e.data?e.data.text():''}}
 e.waitUntil(self.registration.showNotification(d.title||'Audio City Life',{body:d.body||'You have a new message.',tag:d.tag||'acl',renotify:true,icon:'icon-192.png',badge:'icon-192.png',data:{url:'/'}}))});
self.addEventListener('notificationclick',e=>{e.notification.close();const tag=e.notification.tag||'';const url=new URL('./?open='+encodeURIComponent(tag),self.registration.scope).href;
 e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(l=>{for(const c of l){if('focus' in c){try{c.postMessage({open:tag})}catch(x){}return c.focus()}}return self.clients.openWindow(url)}))});
