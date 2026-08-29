# Redutor 3D

Uma ferramenta local para reduzir malhas 3D com preservação geométrica e exportar STL binário validado.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

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

O usuário pode carregar STL, OBJ, PLY, OFF, GLB ou GLTF incorporado, inspecionar a geometria, definir um limite de triângulos, escolher a prioridade de preservação, acompanhar o processamento local, comparar a malha e baixar um STL binário validado.

## User preferences

- Interface em português, escura, tecnológica e com acento laranja.

## Gotchas

- GLTF precisa conter o buffer em data URI; GLB e os formatos textuais principais são processados localmente.
- PLY binário, FBX, DAE, STEP e IGES ainda precisam de conversores dedicados.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
