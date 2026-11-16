import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Plugin, ViteDevServer } from 'vite';

const isCollaborationRequest = (request: IncomingMessage) => {
  try { return new URL(request.url || '/', 'http://localhost').pathname === '/api/collaboration'; }
  catch { return false; }
};

/** Cloudflare's development plugin also owns an upgrade listener. It must not
 * dispatch the independent document API's proxied sockets into a Worker and
 * destroy them when the Worker returns an ordinary response. Capture only the
 * listeners installed by that plugin; retain its handling for all other paths. */
export function preserveApiWebSockets(plugin: Plugin): Plugin {
  const hook = plugin.configureServer;
  if (!hook) return plugin;
  const configure = typeof hook === 'function' ? hook : hook.handler;
  const wrapped: NonNullable<Plugin['configureServer']> = async function (server: ViteDevServer) {
    const protect = async <T>(run: () => T | Promise<T>): Promise<T> => {
      const httpServer = server.httpServer;
      if (!httpServer) return run();
      const previous = new Set(httpServer.listeners('upgrade'));
      try { return await run(); }
      finally {
        for (const registered of httpServer.listeners('upgrade')) {
          if (previous.has(registered)) continue;
          const listener = registered as (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
          httpServer.removeListener('upgrade', listener);
          httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
            if (!isCollaborationRequest(request)) listener.call(httpServer, request, socket, head);
          });
        }
      }
    };
    const post = await protect(() => configure.call(this, server));
    if (post) return () => protect(() => post.call(this));
  };
  return { ...plugin, configureServer: typeof hook === 'function' ? wrapped : { ...hook, handler: wrapped } };
}
