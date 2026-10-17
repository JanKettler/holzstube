// Eleventy-Einstellungen für Jans Holzstube
export default function (eleventyConfig) {
  // Bilder, Styles und Skripte unverändert übernehmen
  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addWatchTarget("src/assets/");

  // Daten als JSON in die Seite einbetten (für die Skripte)
  eleventyConfig.addFilter("alsJson", (wert) =>
    JSON.stringify(wert).replace(/</g, "\\u003c")
  );

  return {
    dir: { input: "src", includes: "_includes", data: "_data", output: "_site" },
    templateFormats: ["njk"],
    htmlTemplateEngine: "njk",
  };
}
