import type { SecretStore } from "../secrets.js";
import { validateLocalModelsRequest, type LocalModelsReply } from "../../../shared/local-connections.js";
import { LocalConnectionStore } from "./connections.js";
import { LocalModelDiscovery, type DiscoveryOptions } from "./discovery.js";

/**
 * Main's `local-models:command` (#378): profile edits and metadata discovery for local model
 * servers. Registered local-only, so a paired desktop can't reach it; the renderer names a
 * connection by id and revision and never supplies an address, path, header or token for a read.
 */
export class LocalModelsService {
  readonly connections: LocalConnectionStore;
  readonly discovery: LocalModelDiscovery;

  constructor(home: string, secrets: SecretStore, options: DiscoveryOptions = {}) {
    this.connections = new LocalConnectionStore(home, secrets);
    this.discovery = new LocalModelDiscovery(this.connections, options);
  }

  async handle(input: unknown): Promise<LocalModelsReply> {
    const request = validateLocalModelsRequest(input);
    if (!request) throw new Error("Invalid local model request.");
    switch (request.op) {
      case "list": return { op: "list", connections: this.connections.list() };
      case "create": return { op: "create", connection: this.connections.create(request.input) };
      case "update": {
        const connection = this.connections.update(request.id, request.revision, request.patch);
        this.discovery.invalidate(request.id);
        return { op: "update", connection };
      }
      case "delete":
        this.connections.delete(request.id, request.revision);
        this.discovery.invalidate(request.id);
        return { op: "delete" };
      case "discover": return { op: "discover", result: await this.discovery.discover(request.connection, request.requestId) };
      case "cancel":
        this.discovery.cancel(request.id);
        return { op: "cancel" };
    }
  }
}
