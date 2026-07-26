export type RigoriumExtensionError = {
  code: "extension_load_failed" | "extension_invalid";
  message: string;
};
