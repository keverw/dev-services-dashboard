import { IncomingMessage, ServerResponse } from "http";
import { ServiceManager } from "./service-manager";
import { Logger } from "./logger";
import { createVFSMiddleware } from "./vfs-middleware";
import frontendVFS from "./frontend-vfs";
import { ApiRouter } from "./api-router";

export class HttpHandler {
  private serviceManager: ServiceManager;
  private vfsMiddleware: (req: IncomingMessage, res: ServerResponse) => boolean;
  private logger: Logger;
  private dashboardName: string;
  private apiRouter: ApiRouter;

  constructor(
    logger: Logger,
    serviceManager: ServiceManager,
    dashboardName?: string,
  ) {
    this.serviceManager = serviceManager;
    this.logger = logger;
    this.dashboardName = dashboardName || "Dev Services Dashboard";
    this.vfsMiddleware = createVFSMiddleware(frontendVFS, {
      excludedPaths: ["/api/services-config"],
    });
    this.apiRouter = new ApiRouter(logger, serviceManager, this.dashboardName);
  }

  async handleRequest(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    try {
      // The control API goes first, before the VFS middleware. It has to: the
      // VFS's `excludedPaths` is an exact-match list, so a `/api/v1/*` prefix
      // can't be excluded there, and the API needs methods (POST/DELETE) and
      // JSON error bodies the static middleware doesn't deal in.
      if (ApiRouter.handles(url.pathname)) {
        await this.apiRouter.handle(req, res, url);
        return;
      }

      // Then try to handle with VFS middleware
      if (this.vfsMiddleware(req, res)) {
        return; // Request was handled by VFS middleware
      }

      // Handle API endpoints that are not in VFS
      if (url.pathname === "/api/services-config") {
        await this.handleServicesConfig(res);
      } else {
        this.handleNotFound(res);
      }
    } catch (error) {
      this.logger.error("Error handling HTTP request:", error as object);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  }

  private async handleServicesConfig(res: ServerResponse) {
    const frontendServicesConfig = this.serviceManager
      .getServices()
      .map((s) => ({
        id: s.id,
        name: s.name,
        webLinks: s.liveWebLinks ?? s.webLinks ?? [],
        signals: s.signals || [],
        dependsOn: s.dependsOn || [],
      }));

    const response = JSON.stringify({
      dashboardName: this.dashboardName,
      services: frontendServicesConfig,
    });

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(response);
  }

  private handleNotFound(res: ServerResponse) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
}
