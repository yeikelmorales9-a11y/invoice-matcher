# invoice-matcher
Web app that automatically matches PDF invoices against Excel inventory using TF-IDF + GPT-4o. Built for construction supply companies in Colombia.
# 🏗️ Invoice Matcher — Cruce de Facturas con IA

Herramienta web que automatiza el cruce de facturas PDF contra un inventario Excel usando inteligencia artificial. Desarrollada para empresas del sector construcción en Colombia.

## ¿Qué hace?

1. **Lee una factura en PDF** y extrae todos los ítems automáticamente con GPT-4o
2. **Busca en el inventario Excel** los productos más similares usando TF-IDF
3. **GPT-4o decide el match correcto** entre los 5 mejores candidatos
4. **Exporta los resultados a Excel** con nombre del sistema, código, precios en COP y USD, y peso estimado

## Stack

- **Frontend:** React + Vite
- **Backend:** Node.js + Express
- **IA:** OpenAI GPT-4o
- **PDF parsing:** pdfjs-dist
- **Excel:** SheetJS (xlsx)
- **Deploy:** Vercel (frontend) + Railway o Render (backend)

## Instalación local

```bash
# Clonar el repositorio
git clone https://github.com/tu-usuario/invoice-matcher.git
cd invoice-matcher

# Instalar dependencias
npm install

# Crear archivo de variables de entorno
cp .env.example .env
# Agregar tu OPENAI_API_KEY en el .env

# Correr en desarrollo (frontend + backend juntos)
npm start
```

## Variables de entorno

Crea un archivo `.env` en la raíz con:

```
OPENAI_API_KEY=sk-proj-...
```

## Uso

1. Sube tu factura en **PDF**
2. Sube tu inventario en **Excel (.xlsx)** — debe tener columnas `Nombre` y `Codigo`
3. Ingresa la tasa de cambio COP → USD
4. Haz clic en **Procesar Factura**
5. Descarga los resultados en Excel

## Estados del cruce

| Estado | Significado |
|--------|-------------|
| ✓ Encontrado | GPT-4o encontró el match con alta confianza |
| ⚠ Verificar | Match encontrado pero con confianza media — revisar manualmente |
| ✗ No encontrado | No se encontró ningún candidato válido |

## Arquitectura

```
PDF → GPT-4o extrae ítems
          ↓
   TF-IDF filtra top 5 candidatos del inventario (2000+ items)
          ↓
   GPT-4o elige el match correcto entre candidatos
          ↓
   Exportar Excel con resultados
```

## Estructura del proyecto

```
invoice-matcher/
├── src/
│   └── App.jsx          # Frontend React completo
├── api/
│   └── openai.js        # Handler para Vercel (producción)
├── server.js            # Servidor Express (desarrollo local)
├── vite.config.mjs      # Configuración Vite
├── package.json
└── .env                 # Variables de entorno (no se sube a Git)
```

## .gitignore recomendado

Asegúrate de que tu `.gitignore` incluya:

```
node_modules/
.env
dist/
```

---

Desarrollado por **Yeikel** © 2026
