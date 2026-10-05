import { getReleaseFeed } from "../apps/site/server/github-release.mjs";

export default async function handler(request, response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    response.statusCode = 405;
    response.end();
    return;
  }
  const feed = await getReleaseFeed();
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", feed.stale
    ? "public, max-age=0, s-maxage=60, stale-while-revalidate=300"
    : "public, max-age=0, s-maxage=300, stale-while-revalidate=300");
  response.end(request.method === "HEAD" ? undefined : JSON.stringify(feed));
}
