import http from "node:http";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ImagesConnection } from "../../../shared/images.js";
export interface ImagesLease {
  connection: ImagesConnection;
  close(): Promise<void>;
}
/** Ephemeral job-only registration: no arbitrary library writes or access outside job output. */
export class ImageAgent {
  private routes = new Map<
    string,
    { active: boolean; register(file: string): unknown }
  >();
  private server = http.createServer((req, res) => {
    void this.handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  private listening?: Promise<string>;
  async prepare(
    register: (file: string) => unknown,
    instructions: string,
    signal?: AbortSignal,
  ): Promise<ImagesLease> {
    const base = await (this.listening ??= new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.removeListener("error", reject);
        resolve(
          `http://127.0.0.1:${(this.server.address() as import("node:net").AddressInfo).port}`,
        );
      });
    }));
    signal?.throwIfAborted();
    const token = randomUUID();
    const route = { active: true, register };
    this.routes.set(token, route);
    return {
      connection: { url: `${base}/mcp/${token}`, instructions },
      close: async () => {
        route.active = false;
        this.routes.delete(token);
      },
    };
  }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const port = (this.server.address() as import("node:net").AddressInfo)
      ?.port;
    if (req.headers.origin || req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(403).end();
      return;
    }
    const route = this.routes.get(req.url?.replace(/^\/mcp\//, "") ?? "");
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    const server = new Server(
      { name: "modex-images", version: "1" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "register",
          description:
            "Save a completed generated image from this job's output folder to the Modex library. Pass a relative filename, never a URL.",
          inputSchema: {
            type: "object",
            properties: { file: { type: "string" } },
            required: ["file"],
            additionalProperties: false,
          },
        },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        if (!route.active) throw new Error("Image job ended.");
        const args = request.params.arguments;
        if (
          request.params.name !== "register" ||
          !args ||
          Object.keys(args).length !== 1 ||
          typeof args.file !== "string"
        )
          throw new Error("Provide an output filename.");
        return {
          content: [
            { type: "text", text: JSON.stringify(route.register(args.file)) },
          ],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: (error as Error).message }],
        };
      }
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }
  async dispose() {
    for (const route of this.routes.values()) route.active = false;
    this.routes.clear();
    if (this.listening) {
      await this.listening;
      this.server.closeAllConnections();
      await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }
  }
}
