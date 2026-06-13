# Cognita Hub — Plano: Fase 2.5 (base visual) + Fase 3 (Admin real)

> Objetivo: transformar os `update ... set status = ...` que hoje rodam no SQL Editor
> em botões no painel admin — **Aprovar tutor / Recusar tutor / Aprovar criança /
> Pedir revisão** — com contadores reais. O admin vira operação de verdade, sem
> ninguém mexer no banco por trás.
>
> Referências: `docs/PLANO-V1.md` (§4 admin, §6 redesign) e o rascunho da Fase 3.

---

## 0. Estado real verificado (muda o tamanho do trabalho)

Antes de planejar, conferi o repositório. Três fatos importam:

1. **`pages/admin.html` JÁ está no padrão novo** — sidebar com SVG, filtros de funil,
   colunas pipeline (Triagem / Pareamentos / Ciclos / Relatórios), cards com botão,
   e já carrega `internal.css` (que já tem `.admin-page`, `.pipeline-card`,
   `.admin-filter` etc.). O que é mock são os **dados** (18, 7, 5, 4 e os cards fixos),
   não o layout. → A Fase 2.5 é **menor** do que o rascunho supõe: não é reorganizar
   o admin, é criar tokens + 3 componentes que faltam (badge de status, vazio, carregando)
   e trocar os dados fixos por dados reais.
2. **`js/pages/admin.js` já existe** com `requireRole('admin')` + logout. É o ponto
   de partida do render real.
3. **`requireRole()` (js/lib/auth.js) só confere `role`, não `status`** — pendência
   já anotada antes. Entra nesta fase (item C1).

Pré-requisito zero: o signup precisa estar funcionando (trigger corrigido pelo
`docs/supabase-signup-fix.sql`) e deve existir pelo menos 1 tutor `pending` e
1 criança `waiting_review` de teste para ver o painel vivo.

---

## 1. Decisões fechadas (com correções ao rascunho)

| Decisão | Valor |
|---|---|
| Aprovar tutor | `profiles.status: pending → active` **e** `tutor_applications.status: pending → approved` + `reviewed_by`/`reviewed_at` |
| Recusar tutor | `profiles.status → rejected` **e** `tutor_applications.status → rejected` + `reviewed_by`/`reviewed_at` |
| Aprovar criança | `children.status: waiting_review → waiting_match` |
| Pedir revisão | `children.status → revision_requested` (recomendado; ver A1 — depende do CHECK) |
| Ordem dos 2 updates do tutor | **application primeiro, profile depois, com rollback** (ajuste do Marcus). Aprova a candidatura, ativa o profile; se o profile falhar, devolve a candidatura para `pending` (e limpa `reviewed_*`). Garante que o tutor **nunca** ganha acesso ao painel com candidatura ainda pendente. Upgrade futuro: RPC transacional `approve_tutor()`. |
| Detectar update bloqueado por RLS | **Sempre `.update(...).eq(...).select('id')` e conferir `data.length`.** Sem `.select()`, o PostgREST devolve sucesso mesmo quando o RLS filtrou tudo e **zero linhas** mudaram — o botão "funcionaria" sem fazer nada. |
| Render dos cards | `createElement` + `textContent`, **nunca** `innerHTML` com interpolação — nome/e-mail/motivação vêm de usuário (XSS) e são dado sensível (não logar no console). |
| Pareamentos, Ciclos, Relatórios | Continuam mock nesta fase (colunas ficam como estão). |
| `reviewed_by` / `reviewed_at` | Preencher sempre — é trilha de auditoria de graça e aparece bem na apresentação. |

"Pedir revisão" ≠ "recusar": o cadastro volta para o responsável ajustar, a criança
não é rejeitada. Vale o status próprio (`revision_requested`) se o CHECK permitir.

---

## 2. Parte A — SQL no Supabase (rodar antes do front)

> **Script pronto: `docs/supabase-fase-3.sql`** — inclui tudo desta seção mais os
> ajustes do Marcus: checagem/criação das colunas `reviewed_by`/`reviewed_at`
> (PASSO 2) e o aviso de que o admin precisa estar `role=admin` **e**
> `status=active` (1f) — com o requireRole barrando status, admin `pending`
> se tranca para fora.

Tudo sem bloco `do $$` (o parser do SQL Editor recusa). Rodar **uma consulta por vez**.

### A1 — Verificações (5 selects, decidem o resto)

```sql
-- 1) As funções do rls-fix existem? (precisa aparecer is_admin)
select proname from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and proname in ('is_admin', 'is_guardian_of', 'is_tutor_of');

-- 2) CHECK constraints de status — define se 'revision_requested',
-- 'waiting_match' e 'rejected' são valores aceitos:
select conrelid::regclass as tabela, conname, pg_get_constraintdef(oid) as definicao
from pg_constraint
where contype = 'c'
  and conrelid in ('public.profiles'::regclass, 'public.children'::regclass,
                   'public.tutor_applications'::regclass);

-- 3) FKs — decide se o join embutido do supabase-js funciona.
-- Se tutor_id/guardian_id referenciam public.profiles → embed OK.
-- Se referenciam auth.users → usar o fallback de 2 queries (Parte B).
select conrelid::regclass as tabela, conname, pg_get_constraintdef(oid) as definicao
from pg_constraint
where contype = 'f'
  and conrelid in ('public.tutor_applications'::regclass, 'public.children'::regclass);

-- 4) Policies atuais da profiles — TEM que existir uma de select do
-- próprio usuário (o login depende dela). Só vamos ADICIONAR as de admin.
select policyname, cmd from pg_policies
where schemaname = 'public' and tablename = 'profiles';

-- 5) Existe usuário admin?
select id, email, role, status from public.profiles where role = 'admin';
```

Se o **(5)** vier vazio: Authentication → Users → Add user (ex.: `admin@cognitahub.org`,
com "Auto Confirm"), depois:

```sql
update public.profiles set role = 'admin', status = 'active'
where email = 'admin@cognitahub.org';
```

Se o **(2)** mostrar um CHECK em `children.status` que não inclui `revision_requested`:

```sql
-- Troque <nome_do_check> pelo conname que o A1-2 mostrou:
alter table public.children drop constraint <nome_do_check>;
alter table public.children add constraint children_status_check
  check (status in ('waiting_review', 'revision_requested', 'waiting_match',
                    'matched', 'active', 'completed', 'paused', 'rejected'));
```

(Se não houver CHECK nenhum, `revision_requested` entra direto — nada a fazer.)

### A2 — Permissões de admin na `profiles` (a única tabela que falta)

`children` e `tutor_applications` já têm `*_admin_all` + grants pelo
`supabase-rls-fix.sql` §3/§4. Só a `profiles` precisa de ajuste:

```sql
alter table public.profiles enable row level security;

grant select, update on public.profiles to authenticated;

drop policy if exists profiles_admin_select on public.profiles;
drop policy if exists profiles_admin_update on public.profiles;

create policy profiles_admin_select on public.profiles
  for select to authenticated
  using (public.is_admin());

create policy profiles_admin_update on public.profiles
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());
```

⚠️ Isso **adiciona** acesso de admin sem mexer na policy de "ler o próprio profile"
que o login usa (confirmada no A1-4). Se o A1-4 não mostrar nenhuma policy de
select do próprio usuário e o login mesmo assim funciona, me avise — significa
que RLS estava desligado na profiles e o `enable row level security` acima vai
exigir criar também a policy do próprio usuário:

```sql
-- SÓ se o A1-4 veio vazio:
create policy profiles_self_select on public.profiles
  for select to authenticated using (id = auth.uid());
```

---

## 3. Parte B — Fase 2.5: base visual mínima (1 sessão de trabalho)

Como o admin já tem layout, a Fase 2.5 se reduz a **sistema, não reforma**:

1. **`css/tokens.css` (novo)** — só as variáveis, carregado **antes** de
   `styles.css` em todas as páginas. Conteúdo: o bloco do PLANO-V1 §6
   (cores semânticas `--ok #1c7c54`, `--warn #b3590a`, `--bad #a3123a`,
   `--ink-soft`, `--radius`, `--shadow`, `--border`, escala `--s1..--s6`).
   Não remove nada do legado — convive e os componentes novos passam a usá-lo.
2. **3 componentes novos no `internal.css`** (camada interna, escopados como o resto):
   - `.badge` + `.badge-ok` / `.badge-warn` / `.badge-bad` — status sempre com a
     mesma cara (criança `waiting_review` = warn, tutor `pending` = warn,
     aprovado = ok, recusado = bad). Números tabulares, ~22px de altura.
   - `.empty-state` — ícone simples + frase + (opcional) ação. "Nenhum cadastro
     aguardando análise 🎉" é estado de produto, não tela quebrada.
   - `.is-loading` / `.skeleton` — barra cinza pulsando (respeitando
     `prefers-reduced-motion`) para os cards enquanto a query roda.
3. **Fontes (Atkinson Hyperlegible + Baloo 2)**: decisão separada — exige `<link>`
   do Google Fonts (request externa) ou self-host em `/assets/fonts`. Recomendo
   **adiar para a Fase 7 (redesign geral)** e já deixar `--font-display`/`--font-body`
   no tokens.css apontando para a pilha atual: trocar a fonte depois vira 1 linha.
4. **Não criar `components.css` ainda** — os componentes novos cabem no
   `internal.css`, que já é a camada das telas internas. Quando responsável/tutor
   migrarem para tokens, aí sim vale quebrar em arquivos. Menos arquivo = menos deriva.

---

## 4. Parte C — Código da Fase 3

### C1 — `js/lib/auth.js`: requireRole ganha checagem de status

```js
// dentro de requireRole, depois da checagem de role:
if (profile.status !== 'active') {
  await supabase.auth.signOut()
  window.location.replace('/pages/login.html')
  return null
}
```

Barra `pending` / `rejected` / `inactive` em **todos** os painéis (pendência antiga).

### C2 — `js/data/admin.js` (novo) — camada de dados do admin

Estrutura do rascunho mantida, com 3 reforços: helper que detecta update
silenciosamente bloqueado pelo RLS, `reviewed_by`/`reviewed_at`, e a ordem
application→profile **com rollback** (ajuste do Marcus).

```js
import { supabase } from '../lib/supabase.js'

// Update que FALHA ALTO se o RLS filtrar tudo (sem .select() o PostgREST
// devolve sucesso com zero linhas alteradas e o botão "funciona" à toa).
async function updateOne(table, patch, column, value) {
  const { data, error } = await supabase
    .from(table).update(patch).eq(column, value).select('id')

  if (error) return { error }
  if (!data?.length) {
    return { error: new Error(`Nenhuma linha alterada em ${table} — confira as policies de admin.`) }
  }
  return { data }
}

export function getPendingTutors() {
  return supabase
    .from('tutor_applications')
    .select(`
      id, tutor_id, formation, experience, motivation, linkedin,
      weekly_availability, status, created_at,
      profiles:tutor_id ( name, email, phone, status )
    `)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
}

export function getChildrenWaitingReview() {
  return supabase
    .from('children')
    .select(`
      id, guardian_id, name, birth_date, school_year, has_formal_diagnosis,
      main_difficulties, sensory_notes, routine_notes, status, created_at,
      profiles:guardian_id ( name, email, phone ),
      learning_profiles ( preferred_formats, attention_span, math_difficulties,
                          strengths, motivators, avoidances )
    `)
    .eq('status', 'waiting_review')
    .order('created_at', { ascending: false })
}

// Candidatura primeiro, profile depois: se o profile falhar no meio,
// o tutor NÃO ganha acesso com candidatura pendente. O rollback devolve
// a candidatura à fila para o admin tentar de novo.
export async function approveTutor(tutorId, adminId) {
  const reviewed = { reviewed_by: adminId, reviewed_at: new Date().toISOString() }

  const application = await updateOne('tutor_applications',
    { status: 'approved', ...reviewed }, 'tutor_id', tutorId)
  if (application.error) return application

  const profile = await updateOne('profiles', { status: 'active' }, 'id', tutorId)

  if (profile.error) {
    await updateOne('tutor_applications',
      { status: 'pending', reviewed_by: null, reviewed_at: null }, 'tutor_id', tutorId)
    return profile
  }

  return profile
}

// rejectTutor segue o MESMO padrão (status 'rejected' nos dois updates,
// com o mesmo rollback) — código real em js/data/admin.js.

export function approveChild(childId) {
  return updateOne('children', { status: 'waiting_match' }, 'id', childId)
}

export function requestChildRevision(childId) {
  return updateOne('children', { status: 'revision_requested' }, 'id', childId)
}
```

**Se o A1-3 mostrar FK para `auth.users`** (embed `profiles:tutor_id` dá erro
`PGRST200`), trocar por 2 queries:

```js
const { data: apps, error } = await supabase
  .from('tutor_applications').select('*').eq('status', 'pending')
if (error || !apps?.length) return { data: apps ?? [], error }

const { data: profiles } = await supabase
  .from('profiles').select('id, name, email, phone, status')
  .in('id', apps.map((a) => a.tutor_id))

const byId = new Map((profiles ?? []).map((p) => [p.id, p]))
return { data: apps.map((a) => ({ ...a, profiles: byId.get(a.tutor_id) ?? null })) }
```

### C3 — `pages/admin.html`: coluna Triagem vira dinâmica

Mudança mínima, mantendo o layout que já existe:

- Os 3 `pipeline-card` fixos da coluna `#triagem` saem; entram dois containers:
  `<div data-list-children></div>` e `<div data-list-tutors></div>` (ou um só
  intercalado — mais simples: duas seções com subtítulo "Crianças em análise" /
  "Tutores a validar").
- Contadores reais: `data-count` no `<span>` do header da coluna, no
  `.nav-badge` da sidebar e nos 2 primeiros `.admin-filter` (os filtros de
  Pareamentos/Relatórios mockados ficam, mas sem número inventado — usar "—").
- O `<small>14 pendências hoje</small>` da sidebar vira o total real.
- Card da criança ganha um `<details>` "Ver perfil pedagógico" com
  learning_profile + contato do responsável (LGPD ok: é o admin, papel com
  necessidade de acesso; mesmo assim, nada disso vai para `console.log`).

### C4 — `js/pages/admin.js`: carregar, renderizar, agir

Fluxo no load (depois do `requireRole('admin')` que já existe):

1. Mostrar skeleton nas duas listas.
2. `Promise.all([getPendingTutors(), getChildrenWaitingReview()])`.
3. Erro → `.empty-state` com a mensagem + botão "Tentar de novo".
4. Lista vazia → `.empty-state` ("Nenhum cadastro aguardando análise").
5. Render com `createElement`/`textContent` (helper `el(tag, className, text)`).
   Idade = calculada de `birth_date` (helper local; nada de idade gravada).
6. Botões por card:
   - Tutor: **Aprovar tutor** (`.btn-primary`) / **Recusar** (`.btn-ghost` + `confirm()`).
   - Criança: **Aprovar para pareamento** (`.btn-primary`) / **Pedir revisão**
     (`.btn-ghost` + `confirm()` explicando que o responsável deverá ajustar o cadastro).
7. Ao clicar: desabilita os botões do card ("Aprovando…"), chama a função do
   `admin.js`, e no sucesso **recarrega as duas listas e os contadores**
   (refetch simples > otimismo esperto, no MVP). No erro: reabilita e mostra a
   mensagem no card.
8. `signOut` + Modo Foco continuam como estão.

---

## 5. Roteiro de teste ponta a ponta (o demo da competição)

1. Cadastrar tutor fake no site → login → barrado com "cadastro em análise". ✓
2. Cadastrar responsável fake + criança → login responsável entra (painel ainda mock). ✓
3. Login admin → Triagem mostra **1 tutor e 1 criança reais**, contadores certos.
4. Aprovar tutor → some da fila; conferir no banco `profiles.status='active'`,
   `tutor_applications.status='approved'`, `reviewed_by` preenchido; login do
   tutor agora **entra** no painel.
5. Aprovar criança → some da fila; `children.status='waiting_match'`.
6. Cadastrar 2º tutor e **recusar** → login barrado com "cadastro não aprovado".
7. Cadastrar 2ª criança e **pedir revisão** → `status='revision_requested'`.
8. Fila vazia → empty-state aparece (faz parte do demo!).
9. Logar como responsável e abrir `/pages/admin.html` na unha → expulso pelo
   requireRole; e mesmo via console, queries de admin voltam 0 linhas (RLS).

## 6. Fora de escopo desta fase (segurar firme)

- Pareamentos, ciclos e relatórios reais (Fase 3b/4 — colunas seguem mock).
- Redesign de home, painel tutor e painel responsável; troca de fontes; animações.
- Painel do responsável reagindo a `revision_requested`/`waiting_match` (Fase 5 —
  mas o status já fica gravado certo, pronto para ela).
- `admin_notes` (anotação interna por cadastro) — fácil de adicionar depois,
  não bloqueia a triagem.

## 7. Ordem de execução

> **Status (12/06/2026): B, C1, C2, C3 e C4 implementados localmente.**
> Falta: rodar `docs/supabase-fase-3.sql` no Supabase (passos 1–5) e o
> roteiro de teste do §5. Nada commitado — revisão do Marcus antes de push.

1. ✅ **B** tokens.css (todas as páginas) + badge/empty/skeleton/card-facts no internal.css.
2. ✅ **C1** requireRole barra `status != active` em todos os painéis.
3. ✅ **C2** js/data/admin.js (com rollback na aprovação/recusa de tutor).
4. ✅ **C3 + C4** admin.html com triagem dinâmica + js/pages/admin.js renderizando.
5. ⏳ **A** rodar `docs/supabase-fase-3.sql` (verificações, colunas de auditoria,
   policies da profiles, admin `active`). Se o 1d mostrar FK para `auth.users`,
   me avisar para trocar o embed pelo fallback de 2 queries.
6. ⏳ **§5** roteiro de teste completo.
7. ✅ readme atualizado (painel admin → triagem funcional) — sem commit;

