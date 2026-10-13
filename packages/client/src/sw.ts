/// <reference lib="webworker" />
import { cleanupOutdatedCaches, precacheAndRoute } from "workbox-precaching";
import { clientsClaim } from "workbox-core";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { createHandlerBoundToURL } from "workbox-precaching";

declare const self: ServiceWorkerGlobalScope;

self.skipWaiting();
clientsClaim();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// App shell for navigations; /api and /ws are never cached (network only).
registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html"), { denylist: [/^\/api\//, /^\/ws/] }));

interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  kind: string;
  unitId?: string;
}

self.addEventListener("push", (event) => {
  let data: PushPayload = { title: "Hex Command", body: "", tag: "hexcommand", url: "/", kind: "info" };
  try {
    if (event.data) data = { ...data, ...(event.data.json() as Partial<PushPayload>) };
  } catch {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url },
      renotify: true,
    } as NotificationOptions),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? "/";
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) {
        if ("focus" in c) {
          await c.focus();
          c.postMessage({ type: "open-url", url });
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
