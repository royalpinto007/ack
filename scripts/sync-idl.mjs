import { copyFile } from "node:fs/promises";
await copyFile("target/idl/ack.json", "idl/ack.json");
console.log("Updated the versioned client IDL from the compiled program.");
