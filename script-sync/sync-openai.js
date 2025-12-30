import dotenv from 'dotenv'
dotenv.config();
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import OpenAI from 'openai'

/* require('dotenv').config();
const fs = require("node:fs")
const fsPromises = require("node:fs/promises");
const path = require("node:path");
const OpenAI = require("openai"); */

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Ajustá estos valores a tu entorno
const VECTOR_STORE_ID = process.env.VECTOR_STORE_ID;
const LOCAL_FILE_PATH_PRODUCTOS = process.env.FILE_PRODUCTOS;
const LOCAL_FILE_PATH_FAQ = process.env.FILE_FAQ;
const LOCAL_FILE_PATH_INFO = process.env.FILE_INFO;
const TARGET_FILE_NAME_PRODUCTOS = "productos.json";
const TARGET_FILE_NAME_FAQ = 'faq.md';
const TARGET_FILE_NAME_INFO = 'nimat_conocimiento_general.md';

async function findExistingFileByFilename(vectorStoreId, targetFileName) {
  // 1) Listar archivos del vector store
  const list = await client.vectorStores.files.list(vectorStoreId);
  const items = list.data ?? list;

  for (const item of items) {
    const fileId = item.id || item.file_id || item; // depende de la versión de la API
    if (!fileId) continue;

    // 2) Preguntar a Files API por los metadatos
    const fileInfo = await client.files.retrieve(fileId);

    // En el SDK nuevo suele ser fileInfo.filename
    if (fileInfo.filename === targetFileName) {
      return {
        vectorStoreFileId: item.id, // id del vínculo en el vector store
        fileId: fileInfo.id,        // id del file en Files API
        filename: fileInfo.filename,
      };
    }
  }

  return null;
}

async function main() {
  if (!VECTOR_STORE_ID) {
    console.error("Falta la variable VECTOR_STORE_ID");
    process.exit(1);
  }

  // 0) Verificar archivo local
  try {
    await fsPromises.access(LOCAL_FILE_PATH_PRODUCTOS);
  } catch {
    console.error(`No se encuentra el archivo local: ${LOCAL_FILE_PATH_PRODUCTOS}`);
    process.exit(1);
  }
  try {
    await fsPromises.access(LOCAL_FILE_PATH_FAQ);
  } catch {
    console.error(`No se encuentra el archivo local: ${LOCAL_FILE_PATH_FAQ}`);
    process.exit(1);
  }
  try {
    await fsPromises.access(LOCAL_FILE_PATH_INFO);
  } catch {
    console.error(`No se encuentra el archivo local: ${LOCAL_FILE_PATH_INFO}`);
    process.exit(1);
  }

  console.log(`📂 Vector store: ${VECTOR_STORE_ID}`);
  console.log(`📄 Archivos local: ${LOCAL_FILE_PATH_PRODUCTOS}, ${LOCAL_FILE_PATH_FAQ}, ${LOCAL_FILE_PATH_INFO}`);

  // 1) Buscar si ya existe un producto.json en el vector store (por filename real)
  console.log("🔍 Buscando productos.json/faq.md/nimat_conocimiento_general.md existenten en el vector store...");
  const existing = await findExistingFileByFilename(VECTOR_STORE_ID, TARGET_FILE_NAME_PRODUCTOS);
  const existingFAQ = await findExistingFileByFilename(VECTOR_STORE_ID, TARGET_FILE_NAME_FAQ);
  const existingINFO = await findExistingFileByFilename(VECTOR_STORE_ID, TARGET_FILE_NAME_INFO);

  if (existing && existingFAQ && existingINFO) {
    console.log(
      `Encontrado: 
        Producto: ${existing.filename} (vectorStoreFileId: ${existing.vectorStoreFileId}, fileId: ${existing.fileId})\n
        FAQ: ${existingFAQ.filename} (vectorStoreFileId: ${existingFAQ.vectorStoreFileId}, fileId: ${existingFAQ.fileId})\n
        INFO: ${existingINFO.filename} (vectorStoreFileId: ${existingINFO.vectorStoreFileId}, fileId: ${existingINFO.fileId})\n
      `
    );
  } else {
    console.log("No hay archivos previo en el vector store.");
  }

  // 2) Subir nuevo archivo a Files API
  console.log("⬆️ Subiendo nuevo archivos a Files API...");
  const uploadedFile = await client.files.create({
    file: fs.createReadStream(LOCAL_FILE_PATH_PRODUCTOS),
    purpose: "assistants",
    //filename: path.basename(LOCAL_FILE_PATH_PRODUCTOS),
  });
  const uploadedFileFAQ = await client.files.create({
    file: fs.createReadStream(LOCAL_FILE_PATH_FAQ),
    purpose: "assistants"
  });
  const uploadedFileINFO = await client.files.create({
    file: fs.createReadStream(LOCAL_FILE_PATH_INFO),
    purpose: "assistants"
  });

  console.log(`Nuevo files subido. fileId: ${uploadedFile.id}, ${uploadedFileFAQ.id}, ${uploadedFileINFO.id}`);

  // 3) Asociar el nuevo file al vector store
  console.log("📌 Asociando nuevo files al vector store...");
  await client.vectorStores.files.create(VECTOR_STORE_ID, {
    file_id: uploadedFile.id,
  });
  await client.vectorStores.files.create(VECTOR_STORE_ID, {
    file_id: uploadedFileFAQ.id,
  });
  await client.vectorStores.files.create(VECTOR_STORE_ID, {
    file_id: uploadedFileINFO.id,
  });

  console.log("✅ Asociado correctamente.");

  // 4) (Opcional) Eliminar el vínculo viejo del vector store
  if (existing?.vectorStoreFileId && existingFAQ?.vectorStoreFileId && existingINFO?.vectorStoreFileId) {
      console.log("🧹 Eliminando archivo viejo del vector store...");
      await client.vectorStores.files.delete(existing.vectorStoreFileId, {vector_store_id: VECTOR_STORE_ID});
      await client.vectorStores.files.delete(existingFAQ.vectorStoreFileId, {vector_store_id: VECTOR_STORE_ID});
      await client.vectorStores.files.delete(existingINFO.vectorStoreFileId, {vector_store_id: VECTOR_STORE_ID});
      console.log("Viejo vínculo eliminado del vector store.");
      console.log("🧹 Eliminando archivos viejo");
      await client.files.delete(existing.fileId);
      await client.files.delete(existingFAQ.fileId);
      await client.files.delete(existingINFO.fileId);
      console.log("Archivos viejo eliminado")
  }

  console.log("🎉 Listo: vector store actualizado");
  console.log("🎉 Listo: archivos viejo eliminado");
}

main().catch((err) => {
  console.error("Error actualizando el vector store:", err.response?.data ?? err);
  process.exit(1);
});
