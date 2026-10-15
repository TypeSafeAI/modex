import type { Attachment, StagedFile } from "./attachments.js";
import type { ThreadItem } from "./types.js";
export const IMAGE_SCHEME = "modex-image";
export const IMAGE_LIMITS = {
  bytes: 25 * 1024 * 1024,
  pixels: 40_000_000,
  batch: 20,
};
export const imageUrl = (id: string, thumbnail = false) =>
  `${IMAGE_SCHEME}://asset/${id}${thumbnail ? "/thumbnail" : ""}`;
export interface ImageAsset {
  id: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  size: number;
  createdAt: string;
  updatedAt: string;
  favorite: boolean;
  trashedAt: string | null;
  projectId?: string;
  source: "imported" | "generated" | "attachment";
  jobId?: string;
  parentIds: string[];
  prompt?: string;
}
export interface ImageQuery {
  query?: string;
  projectId?: string;
  view?: "all" | "generated" | "imported" | "favorites" | "trash";
  sort?: "newest" | "name";
  offset?: number;
}
export interface ImageCapability {
  id: string;
  pluginId: string;
  pluginVersion: string;
  runtime: "claude" | "codex";
  account?: string;
  entrypoint: string;
  label: string;
  edit: boolean;
  verifiedVersion?: string;
}
export interface ImageDraft {
  prompt: string;
  capabilityId: string;
  referenceIds: string[];
  projectId?: string;
}
export type ImageJobStatus =
  | "queued"
  | "running"
  | "waiting-for-approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";
export interface ImageJob extends ImageDraft {
  id: string;
  capability: ImageCapability;
  status: ImageJobStatus;
  threadId?: string;
  outputIds: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
  retryOf?: string;
}
export interface ImageCommands {
  "features:media": {
    req: undefined;
    res: { images: boolean; plugins: boolean };
  };
  "images:list": {
    req: ImageQuery;
    res: { assets: ImageAsset[]; total: number; nextOffset: number | null };
  };
  "images:get": { req: { id: string }; res: ImageAsset };
  "images:import": {
    req: { files: StagedFile[]; projectId?: string };
    res: { assets: ImageAsset[]; errors: string[] };
  };
  "images:pick": {
    req: { projectId?: string };
    res: { assets: ImageAsset[]; errors: string[] };
  };
  "images:update": {
    req: {
      id: string;
      name?: string;
      favorite?: boolean;
      trash?: boolean;
      projectId?: string | null;
    };
    res: ImageAsset;
  };
  "images:delete": { req: { id: string }; res: void };
  "images:export": { req: { id: string }; res: string | null };
  "images:reveal": { req: { id: string }; res: void };
  "images:attachment": { req: { attachment: Attachment }; res: ImageAsset };
  "images:stage": { req: { id: string }; res: StagedFile };
  "images:insert": {
    req: { id: string; pageId: string; revision: number };
    res: void;
  };
  "images:capabilities": { req: undefined; res: ImageCapability[] };
  "images:bind": {
    req: Omit<ImageCapability, "id" | "verifiedVersion">;
    res: ImageCapability;
  };
  "images:unbind": { req: { id: string }; res: void };
  "images:draft": { req: undefined; res: ImageDraft };
  "images:saveDraft": { req: ImageDraft; res: void };
  "imageJobs:list": { req: undefined; res: ImageJob[] };
  "imageJobs:submit": {
    req: ImageDraft & { requestId: string };
    res: ImageJob;
  };
  "imageJobs:cancel": { req: { id: string }; res: void };
  "imageJobs:retry": { req: { id: string; requestId: string }; res: ImageJob };
  "imageJobs:items": { req: { id: string }; res: ThreadItem[] };
  "imageJobs:answer": {
    req: { id: string; itemId: string; answer: "yes" | "no" };
    res: void;
  };
}
export interface ImagesConnection {
  url: string;
  instructions: string;
}
