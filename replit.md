# Compressor 3D (+ Redutor de Geometria)

Uma ferramenta local com dois modos: **Compressor Lossless** (fluxo principal — reduz o tamanho do arquivo sem tocar na malha) e **Redutor de Geometria** (decimação feature-aware, modo separado).

## Run & Operate

- `pnpm --filter @workspace/redutor-3d run dev` — run the frontend (port provided by the managed artifact workflow)
- `pnpm --filter @workspace/api-server run dev` — run the API server (port provided by the managed artifact workflow)
- `pnpm run typecheck` — full typecheck across all packages
- `PORT=20943 BASE_PATH=/ pnpm run build` — typecheck + build all packages locally; managed artifact builds provide these values automatically
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/scripts run validate:compression` — testes do compressor (30 checks, inclui modelo de 300k faces)
- `pnpm --filter @workspace/scripts run validate:decimation` — testes de regressão do redutor (19 checks)
- Required env: `DATABASE_URL` — Postgres connection string

## Netlify

- Framework: React + Vite in a pnpm workspace.
- Build command: `pnpm run build:netlify`
- Publish directory: `artifacts/redutor-3d/dist/public`
- SPA fallback and Node 24 are configured in the root `netlify.toml`.
- The frontend processes files locally and does not require `DATABASE_URL` to build or run on Netlify.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/redutor-3d/src/App.tsx` — interface e fluxo de importação, otimização e exportação.
- `artifacts/redutor-3d/src/lib/mesh/` — parser, análise, simplificador QEM, Worker e exportador STL.
- `artifacts/redutor-3d/src/index.css` — tokens visuais e identidade da estação de trabalho.

## Architecture decisions

- Todo processamento pesado roda em Web Workers para manter a interface responsiva.
- O arquivo original é reaberto a partir do objeto `File` quando necessário; buffers intermediários são transferidos aos Workers.
- MODO 1 — Compressor Lossless (`src/lib/compress/`): pipeline IMPORTAÇÃO → ANÁLISE → COMPRESSÃO → VALIDAÇÃO → DOWNLOAD. Módulos: `sha256.ts` (SHA-256 puro, incremental), `formats.ts` (FormatDetector por conteúdo), `analyzer.ts` (entropia/redundância), `engine.ts` (CAMADA A shuffle reversível + CAMADA B DEFLATE/gzip por streaming, seleção smart com verificação da vencedora), `container.ts` (.3dpack v1 + .gz universal), `validation.ts` (14 pontos: bytes, SHA-256, faces, bbox, volume, reabertura independente). NÍVEL A = byte-lossless (SHA igual ou FAIL); NÍVEL B = geometry-lossless (sinalizado). Integridade > tamanho, sempre.
- MODO 2 — Engine `FEATURE-AWARE ADAPTIVE MESH DECIMATION` (`src/lib/mesh/`): a integridade geométrica tem prioridade absoluta sobre o número de faces (target é meta, não autorização para deformar).
- `complexity.ts` — mapa de complexidade geométrica: curvatura, variação de normais, dihedral angle, densidade local, estrutura fina e silhueta classificam cada vértice (plana/curva/alta/micro/feature-crítica) com FEATURE LOCK nas regiões críticas.
- `safeguards.ts` — cada edge collapse passa por SIMULATE → VALIDATE → COMMIT/REJECT: link condition, regra de borda (zero novos buracos), flip de normais adaptativo, aspect ratio, teto de deslocamento por plano e Hausdorff aproximado por grade espacial.
- `simplifier.ts` — custo combinado QEM + curvatura + feature + silhueta + estrutura fina; heap com versionamento (sem entradas obsoletas); controle de deriva acumulada por vértice (componentes normal/tangencial vs. referência imutável); decimação progressiva por estágios com snapshot, rollback e quality floor por preset.
- Contagens de aresta incrementais exatas (a causa-raiz dos buracos no motor anterior era a reconstrução parcial dessas contagens) e welding controlado com union-find e tolerância proporcional à escala.
- A exportação padrão é STL binário e só é liberada após validação independente do buffer.
- Regressão executável: `pnpm --filter @workspace/scripts run validate:decimation` (cubo, esfera, modelo orgânico com microdetalhes, STL round-trip, welding, checklist de aprovação).

## Product

MODO 1 — Compressor Lossless (fluxo principal): o usuário carrega STL, OBJ, PLY, OFF, GLB, GLTF, FBX, DAE, 3MF ou .3dpack, vê a análise (formato, tamanho, faces, SHA-256, entropia), escolhe o nível (máxima velocidade / balanceado / máxima compressão), comprime e baixa `.3dpack` + `.gz` universal + o original reconstruído — tudo validado byte a byte (LOSSLESS PASS). A malha nunca é modificada.

MODO 2 — Redutor de Geometria (separado): inspecionar a geometria, definir um limite de triângulos, escolher a prioridade de preservação, acompanhar o processamento local, comparar a malha e baixar um STL binário validado.

## User preferences

- Interface em português, escura, tecnológica e com acento laranja.

## Gotchas

- GLTF precisa conter os buffers em data URI; GLB e os formatos principais são processados localmente.
- FBX é lido pelo loader binário/textual; DAE usa o loader Collada com fallback XML para Worker.
- STEP e IGES são formatos CAD/B-rep e ainda precisam de um conversor de sólidos dedicado antes da redução de malha.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
