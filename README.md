# 📋 Kanban

App nativa de Mac para gestionar tus tareas diarias con tablero Kanban, rediseñada con sistema de diseño propio (tema dark + toggle de claro) y funcionalidades avanzadas.

## 💻 Instalar en otra Mac

Necesitás [Git](https://git-scm.com/) y [Node.js](https://nodejs.org/) (o `brew install node`).

```bash
git clone git@github.com:theUvas/kanban.git ~/Desktop/kanban
cd ~/Desktop/kanban
npm install
bash build-app.sh
open /Applications/Kanban.app
```

Si `git clone` con SSH falla, usá HTTPS:

```bash
git clone https://github.com/theUvas/kanban.git ~/Desktop/kanban
```

El repo es **privado**. En la otra Mac tenés que estar logueado en GitHub (`gh auth login` o una SSH key / PAT).

Después de instalar, la app queda en **Aplicaciones** y se abre desde Launchpad, Spotlight o el Dock.

## 🚀 Uso rápido

### Opción 1: Desde Dock / Launchpad / Spotlight ← Recomendado

1. **`Kanban.app`** está en **Aplicaciones**. Abrilo desde Launchpad, Spotlight o el Dock.
2. Desde terminal: `open /Applications/Kanban.app`

### Opción 2: Desde terminal

```bash
# Arranca todo (servidor + app)
bash ~/Desktop/kanban/launch.sh

# O solo la app si el servidor ya está corriendo:
open /Applications/Kanban.app
```

### Opción 3: Solo abrir en el navegador

```bash
cd ~/Desktop/kanban
npm start
# Abrí http://127.0.0.1:3456
```

## ⚠️ Nota importante
**Kanban.app no necesita servidor.** Electron carga `index.html` directo. El servidor en http://127.0.0.1:3456 es solo si querés usarlo en el navegador (`npm start` o `bash start.sh`).

## 🔄 Sincronización con AgentNet

La app nativa reutiliza automáticamente la credencial del puente de AgentNet en
`~/.config/agentnet/worker.json`. No guarda otro token ni expone la credencial
al navegador. Al abrirse, publica el tablero local si AgentNet todavía está
vacío; después sincroniza tareas y proyectos al guardar y consulta cambios cada
15 segundos.

Los conflictos usan revisiones del servidor y el `savedAt` del formato
existente: gana el cambio más reciente y nunca se sobrescribe una revisión nueva
de forma silenciosa. Los cambios recibidos desde AgentNet pasan por el mismo
almacenamiento nativo y luego por la sincronización ya existente con Google
Calendar.

El botón **AgentNet** de la barra superior muestra la revisión sincronizada y
permite forzar una actualización. Si aparece “sin configurar”, conectá primero
la Mac desde AgentNet y volvé a construir la app:

```bash
npm install
npm test
bash build-app.sh
```

## 🔐 Firma de la app
La app está **firmada ad hoc** para evitar que macOS Gatekeeper la bloqueara. Si alguna vez se corrompe, ejecutá:
```bash
# Quitar cuarentena y volver a firmar
sudo xattr -dr com.apple.quarantine /Applications/Kanban.app
sudo xattr -cr /Applications/Kanban.app
codesign --remove-signature /Applications/Kanban.app/Contents/MacOS/Kanban
codesign --sign - --force /Applications/Kanban.app/Contents/MacOS/Kanban
# o rearmás todo de cero:
bash ~/Desktop/kanban/build-app.sh
```

## 🛑 Para detener el servidor
```bash
lsof -ti:3456 | xargs kill -9
```

## ✨ Funcionalidades

- **Tablero Kanban** de 3 columnas (Pendiente / En Progreso / Hecho) con drag & drop entre columnas **y reordenado dentro de la misma columna**.
- **Vista Calendario** mensual con panel de día (crear/editar/eliminar tareas por fecha).
- **Búsqueda** global por título, notas y etiquetas.
- **Completar rápido**: checkbox circular en cada tarjeta (guarda el estado anterior para deshacer el toggle).
- **Subtareas / checklist** con barra de progreso en la tarjeta y edición completa en el modal.
- **Etiquetas** con chips de colores y filtro por etiqueta con contador.
- **Ordenar columnas**: Manual / Prioridad / Fecha límite / Creada.
- **Hora de inicio y fin** en cada tarea (opcional). Eventos con hora van a Google Calendar con horario; sin hora siguen siendo de todo el día.
- **Quick-add con hora**: escribí `15:00 Dentista` o `15:00-16:30 Dentista`.
- **Fechas relativas**: "Hoy", "Mañana", "Ayer", "En N días", "Vencida", y la hora si está cargada.
- **Estadísticas**: pendientes, en progreso, hechas, para hoy, vencidas, % completado con mini-barra.
- **Respaldo JSON**: exportar e importar respaldo completo (con deshacer tras importar).
- **Limpiar hechas**: elimina todas las tareas completadas (con deshacer).
- **Tema dark / claro** con toggle (persiste).
- **Deshacer** eliminaciones e importaciones desde el toast inferior.
- **Selección de tarjeta** + movimiento con teclado.

## ⌨️ Atajos de teclado

| Tecla | Acción |
|---|---|
| `N` | Nueva tarea |
| `/` | Buscar |
| `←` / `→` | Mover tarea seleccionada entre columnas |
| `Delete` | Eliminar tarea seleccionada (con deshacer) |
| `⌘/Ctrl + Enter` | Guardar en el modal |
| `Esc` | Cerrar modal / panel / menús |

## 📂 Estructura

```
kanban/
├── index.html      — La app (HTML + CSS + JS, todo en un archivo)
├── manifest.json   — PWA manifest
├── server.js       — Servidor local (port 3456)
├── package.json    — Scripts npm
├── build-app.sh    — Build de .app (nativefier)
└── launch.sh       — Arranca servidor + abre la app
```

## 💾 Persistencia

Los datos se guardan en `localStorage` y, dentro de Kanban.app, en los archivos nativos `tasks.json` y `projects.json`. El formato es backward-compatible: las tarjetas viejas se migran al cargar agregando `tags`, `subtasks`, `order` y `prevStatus` con defaults. Con AgentNet configurado, la misma estructura se replica en el servidor. Usá **Exportar respaldo** (menú ⋯) para hacer copias de seguridad.
