import { Router, Request, Response } from "express";
import { createLogger } from "../utils/logger.js";

const router = Router();
const log = createLogger("itunes");

// Map iTunes API fields to our Software type, matching Swift CodingKeys
function mapSoftware(item: Record<string, any>) {
  return {
    id: item.trackId,
    bundleID: item.bundleId,
    name: item.trackName,
    version: item.version,
    price: item.price,
    artistName: item.artistName,
    sellerName: item.sellerName,
    description: item.description,
    averageUserRating: item.averageUserRating,
    userRatingCount: item.userRatingCount,
    artworkUrl: item.artworkUrl512,
    screenshotUrls: item.screenshotUrls ?? [],
    minimumOsVersion: item.minimumOsVersion,
    fileSizeBytes: item.fileSizeBytes,
    releaseDate: item.currentVersionReleaseDate ?? item.releaseDate,
    releaseNotes: item.releaseNotes,
    formattedPrice: item.formattedPrice,
    primaryGenreName: item.primaryGenreName,
  };
}

router.get("/search", async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const params = new URLSearchParams(req.query as Record<string, string>);
    const response = await fetch(
      `https://itunes.apple.com/search?${params.toString()}`,
    );
    const data = await response.json();
    const results = (data.results ?? []).map(mapSoftware);
    log.debug("search completed", {
      term: params.get("term"),
      country: params.get("country"),
      entity: params.get("entity"),
      results: results.length,
      upstreamStatus: response.status,
      durationMs: Date.now() - startedAt,
    });
    res.json(results);
  } catch (err) {
    log.error("search request failed", {
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "Search request failed" });
  }
});

router.get("/lookup", async (req: Request, res: Response) => {
  const startedAt = Date.now();
  try {
    const params = new URLSearchParams(req.query as Record<string, string>);
    const response = await fetch(
      `https://itunes.apple.com/lookup?${params.toString()}`,
    );
    const data = await response.json();
    if (!data.resultCount || !data.results?.length) {
      log.debug("lookup found nothing", {
        bundleId: params.get("bundleId"),
        id: params.get("id"),
        country: params.get("country"),
        upstreamStatus: response.status,
        durationMs: Date.now() - startedAt,
      });
      res.json(null);
      return;
    }
    log.debug("lookup completed", {
      bundleId: params.get("bundleId"),
      id: params.get("id"),
      country: params.get("country"),
      upstreamStatus: response.status,
      durationMs: Date.now() - startedAt,
    });
    res.json(mapSoftware(data.results[0]));
  } catch (err) {
    log.error("lookup request failed", {
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: "Lookup request failed" });
  }
});

export default router;
