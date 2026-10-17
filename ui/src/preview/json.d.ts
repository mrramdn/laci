// The fixtures are plain data. ipc.ts says what is in them.
declare module "*.json" {
  const value: unknown;
  export default value;
}
