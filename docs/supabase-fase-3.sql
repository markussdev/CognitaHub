-- ============================================================
-- Cognita Hub — Fase 3 (admin real): preparação no Supabase
-- Rodar no SQL Editor, UM PASSO de cada vez (selecione e Run).
-- Sem blocos "do $$" — o parser do editor recusa o comando "do".
-- ============================================================
-- Pré-requisito: docs/supabase-rls-fix.sql já aplicado (funções
-- is_admin/is_guardian_of/is_tutor_of + policies de children,
-- learning_profiles, consents, support_cycles, tutor_applications).
-- ============================================================

-- PASSO 1 — Verificações (só leitura) -------------------------

-- 1a) Funções do rls-fix existem? Precisa listar as 3.
-- Se vier vazio, rode antes o §1 do supabase-rls-fix.sql.

select proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and proname in ('is_admin', 'is_guardian_of', 'is_tutor_of');

-- 1b) Colunas da tutor_applications — procure reviewed_by e
-- reviewed_at. Se faltarem, o PASSO 2 cria.

select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'tutor_applications';

-- 1c) CHECKs de status — confirme que os valores que a Fase 3 grava
-- são aceitos: profiles (active/rejected), children (waiting_match,
-- revision_requested, rejected), tutor_applications (approved/rejected).
-- Se children.status tiver CHECK sem 'revision_requested' → PASSO 3.

select conrelid::regclass as tabela, conname, pg_get_constraintdef(oid) as definicao
from pg_constraint
where contype = 'c'
  and conrelid in ('public.profiles'::regclass, 'public.children'::regclass,
                   'public.tutor_applications'::regclass);

-- 1d) FKs — decide se o join embutido do front funciona.
-- tutor_id/guardian_id referenciando public.profiles → embed OK.
-- Referenciando auth.users → me avise: troco as queries do
-- js/data/admin.js pelo fallback de 2 consultas.

select conrelid::regclass as tabela, conname, pg_get_constraintdef(oid) as definicao
from pg_constraint
where contype = 'f'
  and conrelid in ('public.tutor_applications'::regclass, 'public.children'::regclass);

-- 1e) Policies atuais da profiles — TEM que existir uma de select do
-- próprio usuário (o login depende dela). O PASSO 4 só ADICIONA as
-- de admin. Se esta consulta vier vazia, veja o aviso do PASSO 4.

select policyname, cmd
from pg_policies
where schemaname = 'public' and tablename = 'profiles';

-- 1f) ⚠️ IMPORTANTE: o requireRole agora barra status != 'active'.
-- O usuário admin PRECISA estar role = 'admin' E status = 'active',
-- senão você se tranca para fora do próprio painel.

select id, email, role, status from public.profiles where role = 'admin';

-- Se o 1f não mostrar nenhum admin: Authentication → Users → Add user
-- (marque Auto Confirm), depois rode (trocando o e-mail):
--
-- update public.profiles set role = 'admin', status = 'active'
-- where email = 'admin@cognitahub.org';
--
-- Se mostrar um admin com status diferente de 'active', rode o mesmo
-- update para corrigir.

-- PASSO 2 — Colunas de auditoria da validação -----------------
-- Idempotente: "if not exists" não dá erro se a coluna já existe.

alter table public.tutor_applications
  add column if not exists reviewed_by uuid references public.profiles (id),
  add column if not exists reviewed_at timestamptz;

-- PASSO 3 — Status 'revision_requested' na children ------------
-- SÓ se o 1c mostrou um CHECK em children.status que não inclui
-- 'revision_requested'. Troque <nome_do_check> pelo conname do 1c,
-- descomente e rode. Se NÃO há CHECK em children.status, pule.

-- alter table public.children drop constraint <nome_do_check>;
-- alter table public.children add constraint children_status_check
--   check (status in ('waiting_review', 'revision_requested', 'waiting_match',
--                     'matched', 'active', 'completed', 'paused', 'rejected'));

-- PASSO 4 — Admin lê e atualiza profiles -----------------------
-- (aprovar tutor = profiles.status 'pending' → 'active' pelo site)

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

-- ⚠️ SÓ se o 1e veio vazio (não existia policy nenhuma na profiles):
-- sem esta, o "enable row level security" acima quebra o login de todo
-- mundo, porque ninguém mais lê o próprio profile.
--
-- create policy profiles_self_select on public.profiles
--   for select to authenticated
--   using (id = auth.uid());

-- PASSO 5 — Conferência final ----------------------------------
-- O que o painel admin vai ver ao carregar:

select count(*) as criancas_em_analise
from public.children where status = 'waiting_review';

select count(*) as tutores_a_validar
from public.tutor_applications where status = 'pending';
