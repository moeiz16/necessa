import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/", "/security", "/changelog"], disallow: ["/api/", "/dashboard", "/cases", "/assistant", "/settings", "/admin", "/knowledge", "/onboarding"] }],
  };
}
