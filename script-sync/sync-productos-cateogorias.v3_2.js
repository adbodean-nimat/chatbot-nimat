// sync-productos-categorias.v3.js
// NIMAT — Sincroniza categorías + productos desde Excel (Dropbox) y genera productos.json listo para e-commerce/RAG
//
// Cambios vs v2:
// - Arregla funciones elegirMejorCategoria / elegirMejorUrlCategoria (en v2 había llaves/returns rotos)
// - Elimina duplicación y ordena el flujo (catalogoCompleto -> productosLimpios)
// - Normaliza keywords robustas (sin acentos, incluye rutas completas y raíz)
// - Corrige url_categoria por defecto (antes armaba con marca)
// - Tipos consistentes: stock como boolean, pero conserva stock_qty opcional
// - Usa fs/promises para async consistente (sincrónico solo donde conviene)
// - Más validación y logs claros

import dotenv from "dotenv";
import { Dropbox } from "dropbox";
import xlsx from "xlsx";
import fs from "node:fs/promises";
import { statSync } from "node:fs";
import { encode } from "@toon-format/toon";

dotenv.config();

// ---- ENV ----
const EXCEL_PRODUCTOS = process.env.EXCEL_PRODUCTOS_PATH;
const EXCEL_CATEGORIAS = process.env.EXCEL_CATEGORIAS_PATH;
const EXCEL_URLS = process.env.EXCEL_URLS_PATH;

const OUTPUT_JSON = process.env.OUTPUT_JSON || "./productos.json";
const OUTPUT_TOON = process.env.OUTPUT_TOON || "./catalogo.toon";

if (!EXCEL_PRODUCTOS || !EXCEL_CATEGORIAS || !EXCEL_URLS) {
  console.error("Faltan ENV: EXCEL_PRODUCTOS_PATH / EXCEL_CATEGORIAS_PATH / EXCEL_URLS_PATH");
  process.exit(1);
}

// ---- Dropbox OAuth (refresh token) ----
async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: process.env.DROPBOX_REFRESH_TOKEN || "",
  });
  const auth = Buffer.from(
    `${process.env.DROPBOX_APP_KEY}:${process.env.DROPBOX_APP_SECRET}`
  ).toString("base64");

  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`OAuth token error ${res.status}: ${errText}`);
  }
  return res.json();
}

let _cachedAccess = null;
async function ensureAccessToken() {
  const now = Date.now();
  if (_cachedAccess && _cachedAccess.expiresAt > now + 30_000) return _cachedAccess.token;

  const t = await getAccessToken();
  _cachedAccess = {
    token: t.access_token,
    expiresAt: now + ((t.expires_in ?? 3600) - 60) * 1000,
  };
  return _cachedAccess.token;
}

// ---- Categorías: árbol + mapa ----
function construirArbolCategorias(categorias) {
  const categoriasMap = {};
  const arbol = [];

  categorias.forEach((cat) => {
    const id = Number(cat.Id);
    categoriasMap[id] = {
      id,
      nombre: cat.Name || "",
      slug: cat.SeName || "",
      url_categoria: cat.SeName ? `https://www.nimat.com.ar/${cat.SeName}` : "https://www.nimat.com.ar/",
      descripcion: cat.Description || "",
      parent_id: Number(cat.ParentCategoryId) || 0,
      orden: Number(cat.DisplayOrder) || 0,
      visible: String(cat.Published).toUpperCase() === "TRUE" || cat.Published === true,
      hijos: [],
    };
  });

  Object.values(categoriasMap).forEach((cat) => {
    if (cat.parent_id === 0) arbol.push(cat);
    else categoriasMap[cat.parent_id]?.hijos.push(cat);
  });

  const ordenar = (cats) => {
    cats.sort((a, b) => a.orden - b.orden);
    cats.forEach((c) => c.hijos?.length && ordenar(c.hijos));
  };
  ordenar(arbol);

  return { arbol, mapa: categoriasMap };
}

function parsearCategorias(categoriesStr) {
  if (!categoriesStr || !String(categoriesStr).trim()) return [];
  return String(categoriesStr)
    .split(";")
    .map((item) => {
      const [id, orden] = item.split("|").map((s) => s.trim());
      return { id: Number(id), orden: Number(orden) || 0 };
    })
    .filter((x) => Number.isFinite(x.id) && x.id > 0);
}

// ---- Normalización + tokens para keywords ----
function normalizarTexto(texto = "") {
  return String(texto)
    .toLowerCase()
    .replace(/×/g, "x")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[“”"']/g, "")
    .replace(/[^a-z0-9\/.\-\sx]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizar(texto) {
  const norm = normalizarTexto(texto);
  if (!norm) return [];
  const tokens = new Set();

  for (const raw of norm.split(" ")) {
    if (!raw) continue;

    if (raw.length >= 3 || /\d/.test(raw)) tokens.add(raw);

    if (raw.includes("x")) {
      const parts = raw.split("x").filter(Boolean);
      if (parts.length >= 2) {
        parts.forEach((p) => {
          tokens.add(p);
          const sinPuntos = p.replace(/\./g, "");
          if (sinPuntos && sinPuntos !== p) tokens.add(sinPuntos);
          const sinCeros = p.replace(/^0+/, "");
          if (sinCeros && sinCeros !== p) tokens.add(sinCeros);
        });
      }
    }

    if (raw.endsWith(".")) tokens.add(raw.slice(0, -1));
    if (raw.endsWith("s") && raw.length > 3 && !raw.endsWith("is")) tokens.add(raw.slice(0, -1));

    if (raw.startsWith("porcellanat")) tokens.add(raw.replace("porcellanat", "porcelanat"));

    if (raw.includes("cincalum")) tokens.add(raw.replace("cincalum", "zincalum"));
    if (raw.includes("zincalum")) tokens.add(raw.replace("zincalum", "cincalum"));
  }

  return Array.from(tokens);
}


function keywordsNormFromCsv(csv = "") {
  return normalizarTexto(csv).split(" ").join(",").replace(/,+/g, ",").replace(/^,|,$/g, "");
}

// Extrae atributos básicos desde nombre/categoría (heurístico, mejorable)
function parseAtributos(nombre = "", categoria = "", keywordsCsv = "") {
  const t = normalizarTexto(nombre);
  const c = normalizarTexto(categoria);
  const k = normalizarTexto(keywordsCsv).replace(/,/g, " ");

  const hay = (re) => re.test(t) || re.test(c) || re.test(k);

  const attrs = {};

  // Colores frecuentes en chapas/paneles
  const colores = ["blanco","negro","gris","rojo","verde","azul","marron","teja","beige","arena","plateado"];
  const colorMatch = colores.find(col => hay(new RegExp(`\\b${col}\\b`)));

  // --- CHAPAS / TECHOS ---
  if (c.startsWith("techos") || hay(/\bchapa(s)?\b/)) {
    attrs.familia = "chapas";

    // uso
    if (hay(/\bzingueri(a|as)\b/)) attrs.uso = "zingueria";
    if (hay(/\btecho(s)?\b|\bcubierta(s)?\b/)) attrs.uso = attrs.uso || "techo";

    // perfil
    if (hay(/\bt101\b|\btrapezoidal\b|\btrapez\b/)) attrs.perfil = "trapezoidal";
    else if (hay(/\bsinusoidal\b|\bondulada\b|\bacanalada\b/)) attrs.perfil = "sinusoidal";
    else if (hay(/\blisa\b/)) attrs.perfil = "lisa";

    // terminación/material
    if (hay(/\bcincalum\b|\baluzinc\b|\bzincalum\b/)) attrs.terminacion = "cincalum";
    else if (hay(/\bgalvanizad(a|o)?\b/)) attrs.terminacion = "galvanizada";
    else if (hay(/\bprepintad(a|o)?\b/)) attrs.terminacion = "prepintada";

    // color
    if (colorMatch) attrs.color = colorMatch;
    const ral = (t.match(/\bral\s*(\d{3,4})\b/) || [])[1];
    if (ral) attrs.color = `ral${ral}`;
    if (hay(/\bcolor\b/)) attrs.terminacion = attrs.terminacion || "prepintada";

    // traslúcidas: policarbonato / plástica / fibra / acrílico
    if (hay(/\bpolicarbonato\b/)) attrs.tipo = "policarbonato";
    else if (hay(/\bacrilic(o|a)\b/)) attrs.tipo = "acrilico";
    else if (hay(/\bfibra\s*de\s*vidrio\b|\bprfv\b/)) attrs.tipo = "fibra_vidrio";
    else if (hay(/\btraslucid(a|o)\b|\bplast(ic|ic)a\b|\bpvc\b/)) attrs.tipo = "plastica_traslucida";

    // cristal / transparente / opal
    if (hay(/\bcristal\b|\btransparen(te|cia)\b|\btransp\b/)) attrs.transparencia = "cristal";
    else if (hay(/\bopal\b|\blechos(o|a)\b|\bblanco\s*opal\b/)) attrs.transparencia = "opal";

    // claraboya / paño
    if (hay(/\bclaraboy(a|as)\b/)) attrs.extra = "claraboya";
    if (hay(/\bpano\b|\bpaño\b/)) attrs.extra = attrs.extra || "pano";

    // largo
    const m = (t.match(/\b(\d+(?:\.\d+)?)\s*(m|mt|mts|metro|metros)\b/) ||
               k.match(/\b(\d+(?:\.\d+)?)\s*(m|mt|mts|metro|metros)\b/));
    if (m) attrs.largo_m = Number(m[1]);

    // espesor/calibre
    const mm = (t.match(/\b(\d+(?:\.\d+)?)\s*mm\b/) || k.match(/\b(\d+(?:\.\d+)?)\s*mm\b/) || []);
    if (mm[1]) attrs.espesor_mm = Number(mm[1]);

    const cal = (t.match(/\b(?:nro|no|c-)\s*(\d{2})\b/) || k.match(/\b(?:nro|no|c-)\s*(\d{2})\b/) || []);
    if (cal[1]) attrs.calibre = cal[1];
  }

  // --- CERÁMICAS / PORCELANATOS ---
  if (hay(/\bporcelanat\b|\bceramic\b|\brevest\b|\bpiso\b/)) {
    attrs.familia = attrs.familia || "ceramicos";

    const dim = (t.match(/\b(\d{2,3})\s*x\s*(\d{2,3})\b/) || k.match(/\b(\d{2,3})\s*x\s*(\d{2,3})\b/) || []);
    if (dim[1] && dim[2]) attrs.medida_cm = `${dim[1]}x${dim[2]}`;

    if (hay(/\bexterior\b|\bext\b/)) attrs.uso = "exterior";
    else if (hay(/\binterior\b|\bint\b/)) attrs.uso = "interior";

    if (hay(/\bantidesliz\b/)) attrs.acabado = "antideslizante";
    else if (hay(/\brectificad(a|o)\b/)) attrs.acabado = "rectificado";
    else if (hay(/\bpulid(a|o)\b/)) attrs.acabado = "pulido";
    else if (hay(/\bsatinad(a|o)\b/)) attrs.acabado = "satinado";
  }

  // --- PINTURAS / MEMBRANAS ---
  if (hay(/\bpintur\b|\blatex\b|\besmalt\b|\bmembran\b|\bimpermeab\b|\bhidrofug\b/)) {
    attrs.familia = attrs.familia || "pinturas";

    const l = (t.match(/\b(\d+(?:\.\d+)?)\s*(l|lt|lts|litro|litros)\b/) ||
               k.match(/\b(\d+(?:\.\d+)?)\s*(l|lt|lts|litro|litros)\b/) || []);
    if (l[1]) attrs.litros = Number(l[1]);

    if (hay(/\binterior\b/)) attrs.uso = "interior";
    else if (hay(/\bexterior\b/)) attrs.uso = "exterior";
  }

  // --- HIERROS ---
  if (hay(/\bhierro\b|\bvarilla\b|\bfierro\b|\bbarra\b|\bmalla\b|\bperfil\b|\bplanchuela\b/)) {
    attrs.familia = attrs.familia || "hierros";
    const d = (t.match(/\b(\d+(?:\.\d+)?)\s*mm\b/) || k.match(/\b(\d+(?:\.\d+)?)\s*mm\b/) || []);
    if (d[1]) attrs.diametro_mm = Number(d[1]);
  }

  return attrs;
}

function mergeTokens(set, ...textos) {
  textos.forEach((t) => tokenizar(t).forEach((tok) => set.add(tok)));
}

// ---- Enriquecimiento: categorías completas + principal ----
function enriquecerProductos(productos, categoriasMap) {
  return productos.map((prod) => {
    const categoriasProd = parsearCategorias(prod.categorias);

    const categoriasInfo = categoriasProd
      .map((cp) => {
        const cat = categoriasMap[cp.id];
        if (!cat) return null;

        const ruta = [];
        let catActual = cat;
        while (catActual) {
          ruta.unshift(catActual.nombre);
          catActual = catActual.parent_id ? categoriasMap[catActual.parent_id] : null;
        }

        return {
          id: cp.id,
          nombre: cat.nombre,
          slug: cat.slug,
          ruta: ruta.join(" > "),
          ruta_principal: ruta[0],
          orden: cp.orden,
        };
      })
      .filter(Boolean);

    const categoriaPrincipal =
      categoriasInfo.length > 0 ? [...categoriasInfo].sort((a, b) => a.orden - b.orden)[0] : null;

    return {
      ...prod,
      categoria_principal: categoriaPrincipal ? categoriaPrincipal.nombre : "General",
      categoria_principal_slug: categoriaPrincipal ? categoriaPrincipal.slug : "general",
      categorias_completas: categoriasInfo,
      ruta_categoria: categoriaPrincipal ? categoriaPrincipal.ruta : "General",
      url_categoria: categoriaPrincipal?.slug
        ? `https://www.nimat.com.ar/${categoriaPrincipal.slug}`
        : "https://www.nimat.com.ar/",
    };
  });
}

// Elegir categoría más descriptiva: la ruta más profunda
function elegirMejorCategoria(p) {
  if (Array.isArray(p.categorias_completas) && p.categorias_completas.length > 0) {
    const categoriaMasProfunda = [...p.categorias_completas].sort((a, b) => {
      const profundidadA = (a.ruta.match(/>/g) || []).length;
      const profundidadB = (b.ruta.match(/>/g) || []).length;
      return profundidadB - profundidadA;
    })[0];
    return categoriaMasProfunda.ruta || p.ruta_categoria || p.categoria_principal || "General";
  }
  return p.ruta_categoria || p.categoria_principal || "General";
}

function elegirMejorUrlCategoria(p) {
  if (Array.isArray(p.categorias_completas) && p.categorias_completas.length > 0) {
    const categoriaMasProfunda = [...p.categorias_completas].sort((a, b) => {
      const profundidadA = (a.ruta.match(/>/g) || []).length;
      const profundidadB = (b.ruta.match(/>/g) || []).length;
      return profundidadB - profundidadA;
    })[0];
    if (categoriaMasProfunda?.slug) return `https://www.nimat.com.ar/${categoriaMasProfunda.slug}`;
  }
  return p.url_categoria || "https://www.nimat.com.ar/";
}

function crearIndicesCategorias(productos) {
  const indices = { por_categoria_id: {}, por_categoria_nombre: {}, por_categoria_slug: {} };

  productos.forEach((prod, idx) => {
    (prod.categorias_completas || []).forEach((cat) => {
      if (!indices.por_categoria_id[cat.id]) indices.por_categoria_id[cat.id] = { info: cat, productos: [] };
      indices.por_categoria_id[cat.id].productos.push(idx);

      indices.por_categoria_nombre[cat.nombre] ||= [];
      indices.por_categoria_nombre[cat.nombre].push(idx);

      indices.por_categoria_slug[cat.slug] ||= [];
      indices.por_categoria_slug[cat.slug].push(idx);
    });
  });

  return indices;
}

export async function sincronizarCompleto() {
  try {
    console.log("🚀 Iniciando sincronización completa...\n");

    const token = await ensureAccessToken();
    const dbx = new Dropbox({ accessToken: token });

    // 1) Categorías
    console.log("📥 Descargando categorías...");
    const resCat = await dbx.filesDownload({ path: EXCEL_CATEGORIAS });
    const wbCat = xlsx.read(resCat.result.fileBinary, { type: "buffer" });
    const categorias = xlsx.utils.sheet_to_json(wbCat.Sheets[wbCat.SheetNames[0]]);
    console.log(`   ✓ Categorías leídas: ${categorias.length}`);

    console.log("🌳 Construyendo árbol de categorías...");
    const { arbol, mapa } = construirArbolCategorias(categorias);
    const categoriasActivas = Object.values(mapa).filter((c) => c.visible);
    console.log(`   ✓ Categorías activas: ${categoriasActivas.length}`);
    console.log(`   ✓ Categorías principales: ${arbol.length}`);

    // 2) Productos
    console.log("\n📥 Descargando productos...");
    const resProd = await dbx.filesDownload({ path: EXCEL_PRODUCTOS });
    const wbProd = xlsx.read(resProd.result.fileBinary, { type: "buffer" });
    const productosRaw = xlsx.utils.sheet_to_json(wbProd.Sheets[wbProd.SheetNames[0]]);
    console.log(`   ✓ Productos leídos: ${productosRaw.length}`);

    // 3) URLs
    console.log("\n📥 Descargando URLs de productos...");
    const resUrls = await dbx.filesDownload({ path: EXCEL_URLS });
    const wbUrls = xlsx.read(resUrls.result.fileBinary, { type: "buffer" });
    const urlsRaw = xlsx.utils.sheet_to_json(wbUrls.Sheets[wbUrls.SheetNames[0]]);
    console.log(`   ✓ URLs leídas: ${urlsRaw.length}`);

    const urlsMap = {};
    urlsRaw.forEach((row) => {
      const sku = String(row.Sku || row.SKU || "").trim();
      if (!sku) return;
      urlsMap[sku] = { id: row.Id || "", url: row.url || "", imageUrl: row.imageUrl || "" };
    });
    console.log(`   ✓ URLs mapeadas: ${Object.keys(urlsMap).length}`);

    // 4) Base productos (filtrado)
    console.log("\n🔄 Procesando productos...");
    const productosBase = productosRaw
      .filter(
        (row) =>
          String(row.Published).toUpperCase() === "TRUE" &&
          String(row.VisibleIndividually).toUpperCase() === "TRUE"
      )
      .map((row) => {
        const sku = String(row.SKU || "").trim();
        const urlData = urlsMap[sku] || { id: "", url: "", imageUrl: "" };

        const stockQty = Number.parseInt(row.StockQuantity, 10);
        const price = Number.parseFloat(row.Price);

        return {
          id: urlData.id,
          sku,
          nombre: row.Name || "",
          descripcion_corta: String(row.ShortDescription || "").replace(/<[^>]+>/g, "").trim(),
          precio: Number.isFinite(price) ? price : 0,
          stock_qty: Number.isFinite(stockQty) ? stockQty : 0,
          marca: row.Manufacturers || "",
          peso_kg: Number.parseFloat(row.Weight) || 0,
          categorias: row.Categories || "",
          url: urlData.url,
          imageUrl: urlData.imageUrl,
          activo: true,
          visible: true,
          keywords: [],
        };
      });

    console.log(`   ✓ Productos candidatos: ${productosBase.length}`);

    // 5) Enriquecer con categorías
    console.log("✨ Enriqueciendo productos con categorías...");
    const productosEnriquecidos = enriquecerProductos(productosBase, mapa);

    // 6) Keywords (nombre + marca + rutas completas + raíz)
    console.log("🔎 Generando keywords...");
    productosEnriquecidos.forEach((p) => {
      const kw = new Set();
      mergeTokens(kw, p.nombre, p.marca, p.categoria_principal, p.ruta_categoria);

      if (Array.isArray(p.categorias_completas)) {
        p.categorias_completas.forEach((c) => mergeTokens(kw, c.nombre, c.ruta, c.ruta_principal));
      }

      if (p.descripcion_corta) mergeTokens(kw, p.descripcion_corta);

      p.keywords = Array.from(kw);
    });

    // 7) Índices
    console.log("📑 Creando índices...");
    const indicesCategorias = crearIndicesCategorias(productosEnriquecidos);

    const indicesMarca = {};
    const indicesPrecio = { economico: [], medio: [], premium: [], alto: [] };

    productosEnriquecidos.forEach((prod, idx) => {
      if (prod.marca) {
        indicesMarca[prod.marca] ||= [];
        indicesMarca[prod.marca].push(idx);
      }
      if (prod.precio < 50000) indicesPrecio.economico.push(idx);
      else if (prod.precio < 150000) indicesPrecio.medio.push(idx);
      else if (prod.precio < 250000) indicesPrecio.premium.push(idx);
      else indicesPrecio.alto.push(idx);
    });

    // 8) Catálogo completo (para debug/analítica/TOON)
    const catalogoCompleto = {
      metadata: {
        ultima_actualizacion: new Date().toISOString(),
        total_productos: productosEnriquecidos.length,
        productos_disponibles: productosEnriquecidos.filter((p) => p.stock_qty > 0).length,
        total_categorias: categoriasActivas.length,
        categorias_principales: arbol.length,
        marcas_total: Object.keys(indicesMarca).length,
      },
      categorias: {
        arbol,
        todas: categoriasActivas.map((c) => ({ id: c.id, nombre: c.nombre, slug: c.slug, parent_id: c.parent_id })),
      },
      indices: {
        por_categoria_id: indicesCategorias.por_categoria_id,
        por_categoria_nombre: indicesCategorias.por_categoria_nombre,
        por_categoria_slug: indicesCategorias.por_categoria_slug,
        por_marca: indicesMarca,
        por_rango_precio: indicesPrecio,
      },
      productos: productosEnriquecidos,
    };

    // 9) productosLimpios (SALIDA FINAL para tu chatbot / web)
    const productosLimpios = catalogoCompleto.productos
      .filter((p) => p.activo && p.visible && p.precio > 0)
      .map((p) => {
        const mejorCategoria = elegirMejorCategoria(p);
        const mejorUrlCategoria = elegirMejorUrlCategoria(p);
        const categoriaRoot = (mejorCategoria || "").split(" > ")[0] || "General";

        const kwFinal = new Set(Array.isArray(p.keywords) ? p.keywords : []);
        mergeTokens(kwFinal, p.nombre, p.marca, mejorCategoria, categoriaRoot);

        return {
          id: p.id,
          activo: p.activo,
          sku: p.sku,
          nombre: String(p.nombre || "").trim(),
          marca: p.marca || "",
          categoria: mejorCategoria,
          categoria_root: categoriaRoot,
          url_categoria: mejorUrlCategoria,
          precio: p.precio,
          stock: (p.stock_qty ?? 0) > 0, // boolean para la web/chat
          stock_qty: p.stock_qty ?? 0,   // opcional (útil para reporting)
          url: p.url || "",
          imageUrl: p.imageUrl || "",
          descripcion_corta: String(p.descripcion_corta || "").trim(),
          peso_kg: p.peso_kg || 0,
          keywords: Array.from(kwFinal).join(","),
          keywords_norm: keywordsNormFromCsv(Array.from(kwFinal).join(",")),
          atributos: parseAtributos(p.nombre, mejorCategoria, Array.from(kwFinal).join(",")),
        };
      });

    // 10) Guardar
    console.log("\n💾 Guardando salidas...");
    await fs.writeFile(OUTPUT_JSON, JSON.stringify(productosLimpios, null, 2), "utf8");
    await fs.writeFile(OUTPUT_TOON, encode(catalogoCompleto));

    console.log("\n✅ SINCRONIZACIÓN COMPLETA\n");
    console.log("📊 Estadísticas:");
    console.log(`   • Total productos activos (salida): ${productosLimpios.length}`);
    console.log(`   • Con stock (salida): ${productosLimpios.filter((p) => p.stock).length}`);
    console.log(`   • Categorías activas: ${catalogoCompleto.metadata.total_categorias}`);
    console.log(`   • Categorías principales: ${catalogoCompleto.metadata.categorias_principales}`);
    console.log(`   • Marcas: ${catalogoCompleto.metadata.marcas_total}`);

    console.log(`\n💾 Archivo generado: ${OUTPUT_JSON} (${(statSync(OUTPUT_JSON).size / 1024).toFixed(2)} KB)`);
    console.log(`💾 Archivo generado: ${OUTPUT_TOON} (${(statSync(OUTPUT_TOON).size / 1024).toFixed(2)} KB)\n`);
  } catch (error) {
    console.error("\n❌ ERROR:", error?.message || error);
    console.error(error);
    process.exitCode = 1;
  }
}

// Ejecutar
sincronizarCompleto();
