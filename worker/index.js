/* eslint-disable no-restricted-globals */

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Trygghet", body: "Varsel" };
  }

  const title = data.title || "Trygghet";
  const options = {
    body: data.body || "Ny hendelse",
    icon: data.icon || "/icon-192.png",
    badge: data.badge || "/icon-192.png",
    data: {
      url: data.url || "/homes",
      home_id: data.home_id || null,
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || "/homes";

  event.waitUntil(
    (async () => {
      const allClients = await clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      const existing = allClients.find((c) => c.url.includes(url));
      if (existing) return existing.focus();

      return clients.openWindow(url);
    })()
  );
});