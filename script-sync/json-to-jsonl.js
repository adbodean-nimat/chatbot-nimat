#!/usr/bin/env node
/**
 * Convierte productos.json (array) → productos_vectorstore.jsonl
 * con:
 * - id estable
 * - content limpio (ideal embeddings)
 * - metadata util para filtros
 * - tags/tokens como arrays (para match duro y rerank)
 *
 * Uso:
 *   node json-to-jsonl.js ./productos.json ./productos_vectorstore.jsonl
 */

import fs from 'fs'
import path from 'path'

function norm(s = "") {
  return String(s).replace(/\s+/g, " ").trim();
}

function stripAccents(str = "") {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function slugify(s = "") {
  const t = stripAccents(norm(s)).toLowerCase();
  return t.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// Limpia textos operativos (whatsapp, “consultar vendedor”, “agotado”, teléfonos)
function limpiarDescripcion(desc = "") {
  let s = String(desc);
  // teléfonos / whatsapp
  s = s.replace(/\+?\d[\d\s\-()]{7,}\d/g, " ");
  // frases típicas operativas
  s = s.replace(/consult(ar|anos|a).*?(vendedor|whatsapp)/ig, " ");
  s = s.replace(/disponibilidad\s+agotad[ao]\.?/ig, " ");
  s = s.replace(/agotad[ao]\.?/ig, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function splitKeywordsToArray(kw = "") {
  // tu fuente ya viene separada por comas
  const parts = String(kw)
    .split(",")
    .map((x) => norm(x).toLowerCase())
    .filter(Boolean);

  // limpia basura: tokens ultra cortos (excepto unidades), duplicados, etc.
  const keepShort = new Set(["kg", "ml", "m2", "m", "cm", "mm", "l", "in"]);
  const out = [];
  const seen = new Set();

  for (const p of parts) {
    if (p.length <= 2 && !keepShort.has(p)) continue;
    // descarta números de 1-2 dígitos sueltos (ruido)
    if (/^\d+$/.test(p) && p.length < 3) continue;
    // descarta tokens con demasiada puntuación
    if ((p.match(/[.,]/g) || []).length >= 3) continue;

    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
    if (out.length >= 80) break;
  }
  return out;
}

function categoryPath(cat = "") {
  const c = norm(cat);
  if (!c) return [];
  return c.split(">").map((x) => norm(x)).filter(Boolean);
}

function buildContent(p, tagsArray) {
  const nombre = norm(p.nombre);
  const marca = norm(p.marca);
  const sku = norm(p.sku);
  const categoria = norm(p.categoria);
  const root = norm(p.categoria_root);
  const peso = p.peso_kg;
  const precio = p.precio;
  const stock = p.stock;

  // NO metas url/image en embeddings (ruido)
  const lines = [];
  lines.push(`Nombre: ${nombre}`);
  if (marca) lines.push(`Marca: ${marca}`);
  if (sku) lines.push(`SKU: ${sku}`);
  if (categoria) lines.push(`Categoría: ${categoria}`);
  if (root) lines.push(`Rubro: ${root}`);
  if (typeof peso === "number" && peso > 0) lines.push(`Peso: ${peso} kg`);
  if (typeof precio === "number") lines.push(`Precio: ${precio} ARS`);
  if (typeof stock === "boolean") lines.push(`Stock: ${stock ? "sí" : "no"}`);

  // Tags limpias como apoyo semántico
  if (tagsArray && tagsArray.length) {
    lines.push(`Tags: ${tagsArray.slice(0, 40).join(", ")}`);
  }
  return lines.join("\n");
}

function main() {
  const [, , inFile, outFile] = process.argv;
  if (!inFile || !outFile) {
    console.error("Uso: node json-to-jsonl.js <productos.json> <salida.jsonl>");
    process.exit(1);
  }

  const raw = fs.readFileSync(inFile, "utf8");
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error("El JSON de entrada debe ser un array");

  const out = fs.createWriteStream(outFile, { encoding: "utf8" });

  let written = 0;
  for (const p of arr) {
    if (p.activo === false) continue;

    const sku = norm(p.sku);
    const id = sku ? `prod_${slugify(sku)}` : `prod_${slugify(p.nombre)}`;

    // tags base: desde keywords, pero sin meter ruido operativo
    const descLimpia = limpiarDescripcion(p.descripcion_corta || "");
    const kw = splitKeywordsToArray(p.keywords || "");

    // Si querés sumar desc técnica, hacelo solo si no parece texto operativo
    // (acá descLimpia ya viene sin whatsapp/agotado)
    // Podés tokenizar descLimpia si tiene contenido útil:
    // kw.push(...descLimpia.split(" ").map(x => x.toLowerCase()))

    const record = {
      id,
      content: buildContent(
        {
          ...p,
          descripcion_corta: descLimpia
        },
        kw
      ),
      metadata: {
        sku,
        nombre: p.nombre || "",
        marca: p.marca || "",
        categoria: p.categoria || "",
        categoria_root: p.categoria_root || "",
        categoria_path: categoryPath(p.categoria || ""),
        precio: typeof p.precio === "number" ? p.precio : null,
        stock: typeof p.stock === "boolean" ? p.stock : null,
        url: p.url || "",
        imageUrl: p.imageUrl || "",
        peso_kg: typeof p.peso_kg === "number" ? p.peso_kg : null,
        tags: kw, // ARRAY (mejor para filtros/rerank)
      },
    };

    out.write(JSON.stringify(record, null, 0) + "\n");
    written++;
  }

  out.end(() => {
    console.log(`OK: escritos ${written} docs en ${outFile}`);
  });
}

main();
