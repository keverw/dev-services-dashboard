import { ServiceManager } from "./service-manager";
import { readFile } from "fs/promises";
import path from "path";
import { logMessage } from "./utils";

export class HttpHandler {
  private devUIHtmlPath: string;
  private faviconPath: string;
  private serviceManager: ServiceManager;

  constructor(serviceManager: ServiceManager) {
    this.serviceManager = serviceManager;
    this.devUIHtmlPath = path.join(__dirname, "..", "frontend", "dev-ui.html");
    this.faviconPath = path.join(
      process.cwd(),
      "scripts",
      "public",
      "favicon.ico",
    );
  }

  async handleRequest(req: any, res: any) {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    try {
      if (url.pathname === "/api/services-config") {
        await this.handleServicesConfig(res);
      } else if (url.pathname === "/") {
        await this.handleRoot(res);
      } else if (url.pathname === "/favicon.ico") {
        await this.handleFavicon(res);
      } else {
        this.handleNotFound(res);
      }
    } catch (error) {
      logMessage("error", "Error handling HTTP request:", error);
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

  private async handleRoot(res: any) {
    try {
      const html = await readFile(this.devUIHtmlPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (error) {
      logMessage("error", `HTML UI file not found: ${this.devUIHtmlPath}`);
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(
        "Dev UI HTML not found. Please ensure dev-ui.html is in the correct location.",
      );
    }
  }

  private async handleFavicon(res: any) {
    try {
      const favicon = await readFile(this.faviconPath);
      res.writeHead(200, { "Content-Type": "image/x-icon" });
      res.end(favicon);
    } catch (error) {
      res.writeHead(204); // No content
      res.end();
    }
  }

  private handleNotFound(res: any) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }
}
