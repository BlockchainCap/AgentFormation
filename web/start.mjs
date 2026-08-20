// App Runner supplies an internal HOSTNAME. Remove it so Next.js uses its
// 0.0.0.0 default while Auth.js derives public URLs from the trusted request.
delete process.env.HOSTNAME;
await import("./server.js");
