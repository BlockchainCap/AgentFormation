import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AgentFormation",
    short_name: "AgentFormation",
    description: "Persistent remote coding agents inside your AWS account",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    orientation: "any",
    icons: [{ src: "/icon", sizes: "192x192", type: "image/png" }],
  };
}
