// .mts = loaded as an ES module. As a .ts file in a package without "type": "module" it is loaded as CommonJS,
// which makes Vite print "The CJS build of Vite's Node API is deprecated".
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/globalSetup.ts"],
    fileParallelism: false, // all tests share one database
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
