# 📋 Kanban

Aplicación compartida para gestionar tareas diarias. La MiniPC aloja el tablero
único y lo publica de forma privada dentro de la Tailnet; también puede usarse
como app nativa en macOS.

## 🌐 Abrir el tablero compartido

Desde cualquier dispositivo conectado a la Tailnet:

```text
https://diego-mp80.tail28a2a4.ts.net:8445/
```

Se puede instalar como PWA desde el navegador en la MiniPC, la MacBook, el móvil
o la tablet. Todos esos accesos leen y escriben la misma instantánea versionada.
La barra superior incluye **Abrir AgentNet** y AgentNet incluye el botón
**Abrir Kanban** para cambiar entre las dos aplicaciones.

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

### Opción 1: Tablero compartido ← Recomendado

Abrí la URL de la MiniPC indicada arriba o instalala desde el navegador.

### Opción 2: Desde Dock / Launchpad / Spotlight

1. **`Kanban.app`** está en **Aplicaciones**. Abrilo desde Launchpad, Spotlight o el Dock.
2. Desde terminal: `open /Applications/Kanban.app`

### Opción 3: Desde terminal

```bash
# Arranca todo (servidor + app)
bash ~/Desktop/kanban/launch.sh

# O solo la app si el servidor ya está corriendo:
open /Applications/Kanban.app
```

### Opción 4: Servidor local de desarrollo

```bash
cd ~/Desktop/kanban
npm start
# Abrí http://127.0.0.1:3456
```

En la MiniPC, `kanban.service` ejecuta el servidor en `127.0.0.1:8791` y
Tailscale Serve lo publica mediante HTTPS en el puerto 8445. El proxy web usa la
API privada de AgentNet sin enviar ninguna credencial al navegador.

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

Todos los agentes de AgentNet, tanto los asignados a la MiniPC como los asignados
a la MacBook, pueden crear, modificar y borrar tareas o eventos cuando Diego
envía la solicitud en modo **Ejecutar**. AgentNet autentica el equipo y el agente,
valida y versiona las operaciones y el tablero web recibe el cambio en unos cinco
segundos. El modo **Conversar** nunca modifica el tablero.

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

## 🛑 Para detener el servidor de la MiniPC
```bash
systemctl --user stop kanban.service
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
