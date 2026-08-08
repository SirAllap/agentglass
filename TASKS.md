# Backlog — PR panel: triage board + one-screen review

Single source of truth. Ticked only when tests, typecheck and build are green.

## Done
- [x] `prLanes.ts` — lane policy + suggested action (16 tests)
- [x] `taskLink.ts` — provider-neutral work-item link (7 tests)
- [x] `fileRail.ts` — what the PR says about this file (13 tests)
- [x] `TriageBoard.tsx` — five lanes, cards, cap, scope stated
- [x] `FileRail.tsx` — rail beside the diff, folds under 1180px
- [x] Board keyboard: 1–5 / j k / h l / ⏎ / a / p, printed
- [x] One action per card, only what the app can really do
- [x] Files: middle column shows one file (toggle, remembered)

## Open — visual rework of the detail, measured against the mockup
- [x] E1 The field strip. The mockup packs AUTHOR · BRANCH→base · CHANGES ·
      REVIEWERS · ASSIGNEE · MILESTONE · LABELS · CHECKS · REVIEW into one dense
      row with 9px uppercase keys. Today's detail spreads the first six over a
      block and carries neither CHECKS nor REVIEW — so the two facts you open a
      pull request to see are not in its header. `PrPanel.tsx`
- [x] E2 Tabs: the mockup marks Files with what it is now ("one screen") and
      warns on Checks/Review counts. Today's tab strip has counts but no state.
      `PrPanel.tsx`
- [x] E3 The pinned bar sits above the masthead in the mockup and below the way
      back today; decide one and make it the same in both. `PrPanel.tsx`
- [x] B5 "Nothing in the conversation names it" over-claims when GitHub capped
      the comment page (`d.truncated?.comments`). Needs wording, not a flag.
      `FileRail.tsx` + `fileRail.ts`
- [x] B6 Rail section order and labels against the mockup: SAID ABOUT THIS FILE ·
      CHECKS BLAMING THIS FILE · YOUR REVIEW · MERGE. `FileRail.tsx`

- [x] D1 Source control: a way to the PR of the branch you are on — and, when
      it is a base branch, to the ones that land on it
- [x] A5 Scroll lives in each column, not on the board (reported from the app)
- [x] A1 Board footer: "the other N want nothing · N without a push in 30 days"
      plus the sweep, matching the mockup. `TriageBoard.tsx`
- [x] A2 Board: loading and empty states. Today an empty board and a board that
      has not loaded look identical. `TriageBoard.tsx`
- [x] A3 Board: the segmented summary bar above the lanes. `TriageBoard.tsx`
- [x] A4 Tests for the board's own rendering (lane counts, cap, scope line).
      `web/test/triage-board.test.ts`
- [x] B1 Rail: the comments YOU have queued on this file, which today are only
      visible inline. `FileRail.tsx` + `fileRail.ts`
- [x] B2 Rail: unresolved threads on this file as a section, with a jump.
      `FileRail.tsx` + `fileRail.ts`
- [x] B3 Rail: state when the detail is still loading — it currently renders as
      "nothing names it", which is a claim rather than a wait. `FileRail.tsx`
- [x] B4 Tests for the rail's rendering. `web/test/file-rail-view.test.ts`
- [x] B5 "Nothing in the conversation names it" is also an over-claim when
      GitHub capped the comment page (`d.truncated?.comments`) — same class as
      B3 but it needs wording, not a flag. Found by the agent that did B1–B4.
- [x] C1 One-file mode: j/k should move the SELECTION, not scroll the stack.
      `PrPanel.tsx` (mine — not for a subagent, it is the shared file)
- [x] D2 The branch chip must OPEN that pull request, not search for it.
      Reported with four screenshots: it landed on "Searching… 1 of 75", then
      "388 matches", then a board filtered to Custom. `GitPanel.tsx`,
      `openPrs.ts`, `prs.ts` — fe1a23b
- [x] F1 A search runs and the board does not answer it. `TriageBoard` draws
      `boardMine`/`boardReview` — its own two fetches — and never looks at
      `prs`, so with the board on, typing a query says "388 matches" above a
      board showing the same cards as before. This is the second half of the
      report ("encima para y no me enseña nada"): the search DID finish, and
      nothing on screen was about it. A query should fall through to the table
      and the board pill bring it back. `PrPanel.tsx` (held by a subagent)
- [x] B7 Wire the rail's review controls, which land unwired: `onApprove`,
      `onRequestChanges`, `onComment`, `onSubmit`, `verdict`, `queuedCount`.
      Undrawn until they exist, so the section still reads as before. The
      submit guard stays in the panel — the rail cannot see the review body.
      `PrPanel.tsx` (held by a subagent)
- [x] B8 (DECIDIDO, no se construye — ver DECISIONS.md «B8: the rail folds
      away and nothing moves to Overview». El CSS del mockup dice `display:none`
      y su nota al pie dice lo contrario; el CSS es lo que DIBUJA.)
      Under 1180px the rail folds away; the mockup moves its four sections
      into Overview instead. `PrPanel.tsx`
      NOT BUILT, and it is David's call rather than mine: the mockup says the
      four sections move into Overview, and every one of them is about "this
      file" — a phrase Overview has no answer to, because no file is selected
      there. Doing it literally means Overview quietly speaking about whichever
      file Files last had open. The alternative is a fold-out under the diff in
      Files, which keeps the sections attached to the file they describe and is
      a deliberate divergence from a mockup he chose. Ask before building.
- [x] B9 `mergeState: "CLEAN"` with zero checks reported draws "Not mergeable"
      — `MERGE_WHY` has no `CLEAN` key. Pre-existing, found by the rail agent.
      Needs a policy call on what "ready" means with no CI. `mergeReason.ts`

## Ronda 2 — reportada desde la app con capturas (2026-08-07)

- [x] M1 Markdown: el cuerpo de un comentario se lee mucho peor que en GitHub.
      Medido contra sus capturas del MISMO comentario: los saltos de línea
      simples se pierden (dos líneas salen como una), las listas no dibujan
      viñeta, la sangría no se respeta, y no hay aire entre bloques. Las
      cabeceras existen pero no pesan. `web/src/lib/markdown.tsx`
- [x] M2 El filtro Humans cuenta los comentarios en línea del bot como humanos.
      «Humans 8» en una PR que ningún humano ha tocado salvo el autor. Un bot
      que comenta sobre una línea de código se está clasificando como persona.
      `PrPanel.tsx`
- [x] M3 Se puede mergear con una review pedida y pendiente. El approve de
      claude[bot] dejó la PR en «Ready to merge» con `garciaae` en «1 pending
      review». Debe avisar antes de mergear — no bloquear, avisar.
      `PrPanel.tsx` (+ `mergeReason.ts` si hace falta)
- [x] M4 El rail: «SAID ABOUT THIS FILE» enseña el marcador crudo
      `<!-- claude-auto-review -->` y resúmenes de PR entera que solo NOMBRAN el
      fichero en una lista. Eso no es «lo que se dijo de este fichero», y por eso
      un fichero saca unos comentarios y otro otros sin patrón visible.
      `FileRail.tsx` + `fileRail.ts`
- [x] D1 B8 — decidido: NO se mudan al Overview. Ver DECISIONS.md.
- [x] D2 La banda, al pixel del mockup: CHECKS compacto, REVIEW con los ceros,
      LABELS en texto plano. `PrPanel.tsx`
- [x] M5 Un hilo RESUELTO debe salir plegado, como en GitHub: una fila con la
      ruta del fichero y un «Show resolved» para abrirlo. Hoy se dibuja entero,
      así que lo ya zanjado ocupa lo mismo que lo vivo y la conversación se lee
      peor cuanto más se ha trabajado. `PrPanel.tsx`
- [x] M6 Referencias a commits dentro de un comentario (`8c362cc → c9ed653`).
      Hoy el click se va a GitHub. Si ese sha es un commit DE ESTA PR debe
      abrirlo dentro de agentglass, en la pestaña Commits; si es de otra PR, a
      GitHub web como hasta ahora. Necesita una costura en `markdown.tsx` (un
      resolutor de sha que le pase el consumidor) + el salto en `PrPanel.tsx`.
      DEPENDE de que aterrice M1 — el markdown tiene dueño ahora mismo.

## Ronda 3 — más capturas desde la app (2026-08-07)

- [x] N1 HTML en línea dentro de un comentario sale como texto crudo:
      `<i>report-only-changed-files is enabled…</i>` se lee con las etiquetas.
      GitHub lo renderiza en cursiva. Hace falta una lista blanca pequeña de
      etiquetas en línea, no permitirlo todo. `web/src/lib/prBody.ts`
- [x] N2 Un sha suelto en el texto (`delta c9ed653 ... a0f1dfc`) no es enlace
      siquiera. Si es un commit DE ESTA PR debe llevar a la vista de Commits con
      ese commit abierto; si no, a GitHub. `prBody.ts` (autolink) + el salto que
      ya existe en `PrPanel.tsx`. Extiende M6, que solo cubría `<a href>`.
- [x] N3 Cada entrada del rail necesita un botón que lleve a ESE comentario en
      Conversation, no al principio de la pestaña. `FileRail.tsx` + `fileRail.ts`
      (la mitad del rail) y el anclaje en `PrPanel.tsx` (mía).
- [x] N4 Un hilo con respuestas se lee mal: falta aire entre el comentario y sus
      respuestas, y falta la línea/sangría que dice a QUÉ está respondiendo cada
      una — GitHub lo dibuja con un carril vertical. `PrPanel.tsx` (Thread).
- [x] N5 El rail dibuja los cuerpos como TEXTO PLANO: `**Review Summary**` sale
      con sus asteriscos. Debe renderizar markdown EN LÍNEA (negrita, code,
      enlaces a su texto) sin estructura de bloque — sigue siendo un extracto de
      tres líneas y el salto de N3 es lo que lleva al original. `FileRail.tsx`

## Auditoría ronda 1 — correctness (hallazgos con evidencia)

MÍOS AHORA (ficheros libres):
- [x] A1 MAJOR `PrPanel.tsx:5462` — en modo un-fichero, j/k ya no resetea el
      scroll: `vScrollerOf(frame)` devuelve null porque `prNav.ts:42` empieza en
      el PADRE y el scroller ES el frame. Aterrizas a media altura del fichero
      siguiente. Probado con bun -e sobre la cadena real. Fix: el mismo fallback
      que usa `jumpHunk` (`?? frame`).
- [x] A5 MAJOR `MergeDialog.tsx:276` — «The approval that unblocked this came
      from automation» se imprime con `humanApproved === false`, que también es
      cierto cuando NADIE ha aprobado. Inventa un approve de bot que no existe.
      Fix: pasar `botApproved` y exigir que exista.
- [x] A8 `PrPanel.tsx:4592` — la banda dice dos cuentas de ficheros distintas:
      CHANGES usa `d.changedFiles` y REVIEW divide por `d.files.length`, que es
      una página capada. «150 files» y «0/100 viewed» en la misma fila.
- [x] A9 `PrPanel.tsx:4379` — `${c.total} passed` cuenta skipped y neutral como
      aprobados: 45 total / 40 success / 5 skipped sale «45 passed» en verde.
      Y `${c.success}/${c.total} running` dice 40/45 cuando van 44.
- [x] A10 `PrPanel.tsx:2887` — en Files el plegado del masthead está muerto:
      `setCondensed` solo se llama desde el onScroll de un elemento que ahora es
      `overflow-hidden`. Llegas plegado desde Overview y no hay forma de abrirlo.
      Regresión mía de hoy.
- [x] A11 `index.css` / `PrPanel.tsx:5605` — el árbol de ficheros pasó de
      `max-h-[calc(100vh-160px)]` a `max-height:100%` contra un contenedor sin
      altura → el porcentaje puede resolver a `none` y dejar el final del árbol
      inalcanzable. MEDIR antes de tocar. Regresión mía de hoy.

CON DUEÑO — encolados hasta que aterricen los subagentes:
- [x] A2 MAJOR `prBody.ts` — una lista numerada con líneas en blanco entre pasos
      sale «1. / 1. / 1.»: el bucle corta en el blanco y cada paso es su propio
      `<ol>`. Antes no se veía porque no había marcador; hoy sí, y miente.
- [x] A3 MAJOR `prBody.ts` + `Block` — una viñeta anidada bajo una lista
      numerada se funde en el `<ol>` del padre y renumera: tres pasos se leen
      como cinco.
- [x] A4 MAJOR `FileRail.tsx:98` — el rail no recibe `awaitingChecks`, así que
      dice «Nothing is blocking it» mientras el masthead y Overview dicen
      «waiting for the checks to start», en la misma pantalla.
- [x] A7 `FileRail.tsx:146` — el botón «💬 Comment» del rail se apaga solo:
      `setMyReview` borra la entrada cuando verbo=comment y cuerpo vacío, y el
      rail lee `hasReviewDraft`. Fix: leer `myReview.verb` sin condición.

DESCARTADO (minor preexistente, no de hoy): el hallazgo 6 — hilos duplicados
bajo cada review del mismo autor. Real, pero es de julio y no lo trajo esta
ronda; no reabre el ciclo.

## Auditoría ronda 1 — error handling (hallazgos con evidencia)

MÍOS:
- [x] B4 MAJOR `GitPanel.tsx:2273` — con DOS repos en el workspace el chip de la
      PR no hace nada: `PrPanel` fija su root una sola vez (`repos[0]`), así que
      `jump.repo !== repo.nameWithOwner` y el salto se queda PENDIENTE en el
      módulo — abrirá esa PR más tarde, cuando el repo coincida por casualidad.
      Fix: que el salto resuelva el root por `nameWithOwner`, y si no se puede,
      `clearPrJump()` + caer a la búsqueda para que el clic haga algo visible.
- [x] B5 MAJOR `server/src/prs.ts:203` — el `as unknown as PrSummary` sigue
      certificando 7 campos que NO se mandan (additions, deletions, changedFiles,
      labels, assignees, milestone, checks). Medido en vivo: `from.checks` es
      undefined y `from.checks.failure` lanza. Es la pantalla negra de 33a3916
      sin arreglar EN SU ORIGEN. Fix: un `PrBranchSummary = Pick<...>`.
- [x] B6 MAJOR `server/src/prs.ts:197` — sin `gh`, deslogueado o con timeout,
      devuelve `{ok:true, into:[]}`: «no pude preguntar» se dibuja como «esta
      rama no tiene PR». Medido quitando gh del PATH. Fix: propagar el fallo con
      needsAuth, como ya hace `prList`.
- [x] B11 `PrPanel.tsx:696` — `shaFromHref` no mira host ni repo: un enlace a
      `https://ci.example.com/builds/commits/8c362cc` se traga la navegación si
      ese prefijo coincide con un commit nuestro. Fix: exigir github.com + el
      repo de la PR.
- [x] B12 `GitPanel.tsx:2293` — el punto del chip es SIEMPRE gris (checks nunca
      viene), y en esta app gris significa «nada ha reportado». Una rama con tres
      checks en rojo se ve igual que una sin CI. Fix: no dibujar punto cuando no
      hay rollup.
- [x] B9 `PrPanel.tsx:4365` — la celda CHECKS no consulta `d.truncated.checks`:
      con 130 checks y el único rojo más allá de los 100 primeros, sale verde.

CON DUEÑO (subagentes dentro ahora mismo):
- [x] B1 MAJOR `FileRail.tsx:403` — en una PR MERGED/CLOSED el rail dice «◯
      GitHub has not finished working it out» bajo un botón «Merge anyway…».
      Overview ya se arregló para no mentir así; el rail lo reintroduce.
- [x] B2 MAJOR `fileRail.ts:119` — `isRoster` descarta CUALQUIER línea con dos
      `|`: un pipeline de shell, una unión de TypeScript, `a || b`. Y encima
      imprime la frase equivocada («named only in a list of files»).
- [x] B7 MAJOR `prBody.ts:270` — dos comentarios HTML en la MISMA línea borran
      todo lo que hay entre ellos: un sticky bot de una línea queda en blanco.
- [x] B8 `prBody.ts:82` — el autolink de sha coge cualquier hexa de 7+: «1234567
      rows migrated» y la palabra «defaced» se vuelven enlaces a un 404.

YA ARREGLADO por A5 (mismo hallazgo desde las dos auditorías): el aviso de merge
que inventaba un approve de bot.

## Auditoría ronda 2 — rendimiento

- [x] P1 MAJOR `FileRail.tsx:147/151` — `saidAbout` y `namedOnlyInRoster` corren
      en el cuerpo del render SIN memo, y hacen EL MISMO recorrido completo.
      Medido con 200 comentarios + 6 informes de 44KB: 11.9ms por render, 21ms
      por cada j/k en el árbol, 3.1s para recorrer 150 ficheros. Fix: un solo
      escaneo que devuelva ambas cosas, y `useMemo` sobre [d, path, drafts].
- [x] P2 MAJOR `fileRail.ts:181` — el conteo `entries` dentro de `argues` NO
      depende de `path` y se recalcula por fichero y por cuerpo: 78% del coste.
      Medido: 0.567ms del 0.725ms de cada `argues` sobre 40KB; preparado una vez
      por cuerpo, preguntar por los 150 ficheros cuesta 0.48ms EN TOTAL.
- [x] P3 `fileRail.ts:350` — `railPreview` aplana el cuerpo ENTERO para enseñar
      260 caracteres: 0.54ms por informe de 40KB. Recortar antes de aplanar.
- [x] P4 `PrPanel.tsx:2996` — `groupCommitsByDay` sin memo y creando un `Intl`
      por commit: 2.98ms con 150 commits, en cada poll de 20s.

## Auditoría ronda 2 — seguridad
- [x] S1 BLOCKER `prBody.ts:159` — XSS ALMACENADA. El href se interpolaba sin
      escapar y una URL puede llevar comilla: un enlace markdown fabricado
      cerraba el atributo y ponía el suyo. El auditor lo cargó como `innerHTML`
      en un Chrome real, lanzó un `mouseover` y el handler SE EJECUTÓ. Arreglado
      escapando el href y sacando el autolink de URLs fuera de anclas y code.
- [x] S2 `prBody.ts:40` — el marcador U+E000 es tecleable, así que un cuerpo
      podía duplicar y descolocar sus propios code spans. Inerte, pero se quita
      del texto del autor antes de levantar los spans.

## Auditoría ronda 3 — código muerto y tipos

- [x] T5 MAJOR `GitPanel.tsx:2310` — REGRESIÓN MÍA: el chip «PR unknown» sale en
      TODO repo sin remoto de GitHub, porque `prsForBranch` devuelve
      `ok:false, error:"no GitHub remote here"` y yo miré `r.error`. Y `needsAuth`
      —el campo que añadí justo para distinguir— no lo lee nadie. Fix: gatear el
      chip en `needsAuth` y dejar callado el caso «aquí no hay GitHub».
- [x] T1 MAJOR `server/src/prs.ts:222` — el `Pick<>` arregló la LISTA de campos,
      no los VALORES: sigue habiendo `as unknown as` sobre el JSON crudo de gh, y
      gh manda `reviewDecision: ""` donde el tipo promete null. El otro mapper
      del MISMO payload sí normaliza (`prs.ts:757`). Pistola cargada.
- [x] T2 MAJOR `FileRail.tsx:166` vs `PrPanel.tsx:3348` — la escalera del
      veredicto de merge está copiada y YA discrepa en 2 de 3 casos: con checks
      corriendo, Overview dice «Nothing is blocking it» y el rail «Waiting for
      the checks». Fix: `mergeVerdict()` en `mergeReason.ts` y que llamen los dos.
- [x] T3 MAJOR `mergeReason.ts:75` — el arreglo de skipped y de página capada
      entró SOLO en la banda: `checksLine` sigue diciendo «45 checks passed» con
      40 corridos, y es la fuente del tooltip de esa misma celda, de Overview y
      del rail. La celda y su propio `title` discrepan en cinco checks.
- [x] T4 MAJOR `fileRail.ts:279` — `namedOnlyInRoster` solo vive en los tests y
      es una SEGUNDA implementación de lo que ya decide `railScan`: cambia la
      regla y la app cambia mientras el test sigue verde sobre la regla vieja.

## Auditoría ronda 3 — tests (probado por MUTACIÓN, no por opinión)

- [x] V1 BLOCKER `pr-board-search.test.ts` entero (26 tests / 58 asserts) NO
      ejecuta `PrPanel.tsx`. Prueba: `return null` al principio de `PrView` —
      el panel entero deja de dibujar — y la suite sigue 1802 pass / 0 fail.
- [ ] V2 BLOCKER la puerta búsqueda-vs-board no sostiene el bug para el que se
      escribió: cambiar `onQuery={setQuery}` por `setServerQuery` deja `searching`
      permanentemente false y la suite verde.
- [x] V11 MAJOR **BUG DE VERDAD, no de tests**: la sangría de listas mezcladas
      anida un nivel de más. `- a\n  - b\n- c\n    - d` da profundidades
      [0,1,0,2]; GitHub pone las dos sublistas al mismo nivel. El depth sale de
      `indexOf` sobre el conjunto de sangrías del bloque entero, no de una pila.
- [x] V5 MAJOR el aviso del merge dialog: cambiar `> 0` por `> 99` (no aparece
      nunca) y verde. Nadie renderiza `MergeDialog` en ningún test.
- [ ] V6 MAJOR el hilo plegado: cambiar `{open && <>` por `{true && <>` y verde.
- [ ] V7 MAJOR la regla de voz del timeline: `lane: ("human" as Lane)` esquiva
      el assert negativo y verde. Vuelven los bots contados como personas.
- [x] V9 MAJOR el chip de rama: INVERTIR el ternario (busca justo cuando SÍ sabe
      el repo — el bug de las cuatro capturas) y verde, porque el test afirma
      las dos ramas del mismo ternario.
- [x] V10 CERRADO — `server/test/pr-branch-lookup.test.ts`, 15 tests. Verificado
      con las tres mutaciones: `if (false)` → 4 rojos, `Array.isArray(r) ? r : []`
      (el bug original) → 3 rojos, y quitar la guarda de la rama → 3 rojos.
- [x] V3 MAJOR la hoja `.agx-md`: quitarla del `<style>` — o volver a poner
      `list-style:none` — y verde. Afirma una constante, no una hoja montada.
- [ ] V4 MAJOR los dos scroll: renombrar la clase a `agx-col3x` (que no existe)
      y verde, porque `"agx-col3x".includes("agx-col3")`.
- [ ] V8 MAJOR la celda de checks: cambiar `{checksStrip}` por `{checksSaid}` y
      verde. Y `toContain("{checksSaid}")` lo satisface el `title=`.
- [ ] V14 el parser de diff parte por el primer `" b/"`: una ruta con « b/»
      dentro sale con la clave rota.
- [ ] V13 tests que fallan con un reformateo (orden de clases Tailwind, espacios
      en una regla CSS). Cuestan más de lo que sujetan.

PARADO AQUÍ por decisión suya («si seguir iterando va a romper código ya hecho,
mejor para ya»). Lo que queda escrito y NO se toca — cada uno con la mutación
exacta que lo demuestra, para el día que se parta `PrPanel.tsx` en piezas:
V2 (la puerta búsqueda-vs-board), V6 (el hilo plegado), V7 (la voz del
timeline), V8 (qué variable dibuja la celda de checks), V4 (los dos scroll, que
solo se puede medir en un navegador), V13 (tests frágiles a un reformateo) y V14 (una ruta con « b/» dentro).
