# Redutor 3D

Uma ferramenta local para reduzir malhas 3D com preservação geométrica e exportar STL binário validado.

## Run & Operate

- `pnpm --filter @workspace/redutor-3d run dev` — run the frontend (port provided by the managed artifact workflow)
- `pnpm --filter @workspace/api-server run dev` — run the API server (port provided by the managed artifact workflow)
- `pnpm run typecheck` — full typecheck across all packages
- `PORT=20943 BASE_PATH=/ pnpm run build` — typecheck + build all packages locally; managed artifact builds provide these values automatically
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
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

- O processamento de malha roda em Web Worker para manter a interface responsiva.
- O arquivo original é reaberto a partir do objeto `File` quando necessário; buffers intermediários são transferidos ao Worker.
- QEM com colapso de arestas é o caminho principal; uma amostragem espacial de segurança garante o limite máximo em malhas patológicas.
- A exportação padrão é STL binário e só é liberada após validação independente do buffer.

## Product

O usuário pode carregar STL, OBJ, PLY, OFF, GLB, GLTF, FBX ou DAE, inspecionar a geometria, definir um limite de triângulos, escolher a prioridade de preservação, acompanhar o processamento local, comparar a malha e baixar um STL binário validado.

## User preferences

- Interface em português, escura, tecnológica e com acento laranja.

## Gotchas

- GLTF precisa conter os buffers em data URI; GLB e os formatos principais são processados localmente.
- FBX é lido pelo loader binário/textual; DAE usa o loader Collada com fallback XML para Worker.
- STEP e IGES são formatos CAD/B-rep e ainda precisam de um conversor de sólidos dedicado antes da redução de malha.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
