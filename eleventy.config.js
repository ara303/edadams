export default function (eleventyConfig) {
  eleventyConfig.addPassthroughCopy("src/css");
  eleventyConfig.addPassthroughCopy("src/js");
  eleventyConfig.addPassthroughCopy("src/img");
  eleventyConfig.addPassthroughCopy("src/favicon.ico");
  return {
    dir: {
      input: "src",
      includes: "_includes",
      output: "dist",
    },
  };
}
