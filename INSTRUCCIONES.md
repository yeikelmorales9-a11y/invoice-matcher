# 🏗️ Yeikel's App — Guía de instalación y publicación

## Paso 1 — Instalar Node.js
Ve a https://nodejs.org → descarga la versión LTS → instala normalmente.

## Paso 2 — Preparar el proyecto
Copia esta carpeta "yeikels-app" donde quieras en tu computador.
Abre la terminal (Windows: PowerShell o cmd), entra a la carpeta y ejecuta:

  cd yeikels-app
  npm install

Además, para poder usar la API localmente debes arrancar un pequeño servidor que maneje las peticiones a `/api`.
En otra terminal (o la misma, según prefieras) ejecuta:

  npm run dev:server

Esto levantará un servidor en http://localhost:3000 que atiende `/api/openai` (anteriormente `claude`).

Si no arrancas ese servidor, las llamadas a la API fallarán con errores HTTP 500/ECONNREFUSED.
## Paso 3 — Subir a GitHub
1. Ve a https://github.com → crea una cuenta gratis si no tienes
2. Clic en "New repository" → nómbralo "yeikels-app" → Public → Create
3. En la terminal ejecuta (reemplaza TU_USUARIO con tu usuario de GitHub):

  git init
  git add .
  git commit -m "primera version"
  git branch -M main
  git remote add origin https://github.com/TU_USUARIO/yeikels-app.git
  git push -u origin main

## Paso 4 — Publicar en Vercel
1. Ve a https://vercel.com → "Sign up" con tu cuenta de GitHub
2. Clic en "Add New Project"
3. Selecciona el repositorio "yeikels-app"
4. En "Build Settings" verifica:
   - Framework: Vite
   - Build Command: npm run build
   - Output Directory: dist
5. Clic en "Deploy"
6. En 2 minutos tendrás una URL tipo: https://yeikels-app.vercel.app
7. ¡Comparte esa URL con tus compañeros!

## Para actualizar la app en el futuro
Solo ejecuta en la terminal:
  git add .
  git commit -m "actualización"
  git push

Vercel detecta el cambio y actualiza la URL automáticamente.

## Probar en local (sin publicar)
  npm run dev
Abre http://localhost:5173 en tu navegador.
