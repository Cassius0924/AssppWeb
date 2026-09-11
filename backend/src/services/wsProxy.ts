import { Server as HttpServer } from "http";
import { logging, server as wisp } from "@mercuryworkshop/wisp-js/server";
import { accessPasswordHash, config, verifyAccessToken } from "../config.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("wisp");

// wisp-js filters its own output before handing it to console, so its level has
// to track ours or the console bridge would never see the lines.
const WISP_LEVELS: Record<string, number> = {
  error: logging.ERROR,
  warn: logging.WARN,
  info: logging.INFO,
  debug: logging.DEBUG,
  trace: logging.DEBUG,
};
logging.set_level(WISP_LEVELS[config.logLevel] ?? logging.INFO);

// Allow only Apple hosts required by bag/auth/purchase/version/download flows.
wisp.options.hostname_whitelist = [
  /^auth\.itunes\.apple\.com$/,
  /^buy\.itunes\.apple\.com$/,
  /^init\.itunes\.apple\.com$/,
  /^p\d+-buy\.itunes\.apple\.com$/,
  /^downloaddispatch\.itunes\.apple\.com$/,
  /^s\.mzstatic\.com$/,
  /^fpinit\.itunes\.apple\.com$/,
];
wisp.options.port_whitelist = [443];
wisp.options.allow_direct_ip = false;
// allow_private_ips must be true: Docker/container DNS may resolve whitelisted
// hostnames to reserved-range IPs (e.g. 198.18.x.x in OrbStack). The hostname
// whitelist above is the primary security control.
wisp.options.allow_private_ips = true;
wisp.options.allow_loopback_ips = false;

export function setupWsProxy(server: HttpServer) {
  server.on("upgrade", (req, socket, head) => {
    const peer =
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0] ||
      req.socket.remoteAddress ||
      "unknown";

    if (req.url?.startsWith("/wisp")) {
      if (accessPasswordHash) {
        const url = new URL(req.url, "http://localhost");
        // Cloudflare URL normalization may append a trailing slash to the query
        // string (e.g. ?token=abc/ instead of ?token=abc), so strip it.
        const token = (url.searchParams.get("token") || "").replace(/\/+$/, "");
        if (!verifyAccessToken(token)) {
          log.warn("upgrade rejected: bad access token", { peer });
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
      }

      log.debug("upgrade accepted", {
        peer,
        origin: req.headers.origin,
        userAgent: req.headers["user-agent"],
      });
      socket.on("error", (err: Error) => {
        log.debug("tunnel socket error", { peer, error: err.message });
      });

      wisp.routeRequest(req, socket, head);
    } else {
      log.debug("upgrade rejected: non-wisp path", { peer, path: req.url });
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
  });
}
