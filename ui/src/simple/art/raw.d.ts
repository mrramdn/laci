// Vite gives a file's text for an import that ends in ?raw.
declare module "*.svg?raw" {
  const text: string;
  export default text;
}
