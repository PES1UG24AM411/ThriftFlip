/** @type {import('next').NextConfig} */
const nextConfig = {
  // Native / ONNX packages must stay on the server and are not bundled by webpack.
  experimental: {
    serverComponentsExternalPackages: ["@xenova/transformers", "onnxruntime-node", "sharp", "pg"],
  },
  // The code was written without a compiler available. Run `npm run typecheck` and fix what it
  // reports, then set ignoreBuildErrors to false so the build checks types again.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
