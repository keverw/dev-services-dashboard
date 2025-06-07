import { ServiceManager } from "./service-manager";
import { logMessage } from "./utils";
import { createVFSMiddleware } from "./vfs-middleware";
import frontendVFS from "./frontend-vfs";

export class HttpHandler {
  private serviceManager: ServiceManager;
  private vfsMiddleware: (req: any, res: any) => boolean;

  constructor(serviceManager: ServiceManager) {
    this.serviceManager = serviceManager;
    this.vfsMiddleware = createVFSMiddleware(frontendVFS, {
      excludedPaths: ["/api/services-config"],
    });
  }

  async handleRequest(req: any, res: any) {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    try {
      // First try to handle with VFS middleware
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
      logMessage("error", "Error handling HTTP request:", error as object);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  }

  private async handleServicesConfig(res: any) {
    const frontendServicesConfig = this.serviceManager
      .getServices()
      .map((s) => ({
        id: s.id,
        name: s.name,
        webLinks: s.webLinks || [],
      }));

    const response = JSON.stringify(frontendServicesConfig);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(response);
  }

  private handleNotFound(res: any) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
}
