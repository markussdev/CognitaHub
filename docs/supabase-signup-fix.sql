-- ============================================================
-- Cognita Hub — Correção do erro "Database error saving new user"
-- (signup 500). Rodar no SQL Editor do Supabase.
-- ============================================================
-- CAUSA PROVÁVEL: o trigger que cria a linha em public.profiles a
-- cada signup está quebrando — por isso TODO cadastro (tutor,
-- responsável, qualquer um) devolve 500. Pode ser trigger duplicado
-- (dois triggers inserindo em profiles) ou trigger antigo com erro.
--
-- ⚠️ Versão SEM blocos "do $$" — o parser do editor recusou o
-- comando "do". Em troca, o PASSO 2a pede para você copiar e rodar
-- os drops que o PASSO 1 gera (são 1 ou 2 linhas).
--
-- Rode UM PASSO de cada vez: selecione o trecho e clique em Run.
-- ============================================================

-- PASSO 1 — Diagnóstico.
-- 1a) Triggers ativos no auth.users. A coluna "comando_drop" já vem
-- pronta para o PASSO 2a. Se aparecerem DUAS linhas, achamos a causa.

select t.tgname  as trigger_name,
       p.proname as function_name,
       format('drop trigger %I on auth.users;', t.tgname) as comando_drop
from pg_trigger t
join pg_proc p on p.oid = t.tgfoid
where t.tgrelid = 'auth.users'::regclass
  and not t.tgisinternal;

-- 1b) Colunas da profiles (procure NOT NULL sem default que o
-- trigger não preencha):

select column_name, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles';

-- 1c) Constraints da profiles (procure CHECKs de role/status):

select conname, pg_get_constraintdef(oid) as definicao
from pg_constraint
where conrelid = 'public.profiles'::regclass;

-- PASSO 2a — Remova TODOS os triggers que o PASSO 1a listou:
-- copie os comandos da coluna "comando_drop" e rode aqui.
-- Os nomes mais comuns já estão cobertos abaixo ("if exists" não dá
-- erro quando o trigger não existe):

drop trigger if exists on_auth_user_created on auth.users;
drop trigger if exists handle_new_user on auth.users;
drop trigger if exists on_new_user on auth.users;
drop trigger if exists create_profile_on_signup on auth.users;

-- PASSO 2b — Recria a função e UM ÚNICO trigger:

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, email, phone, role, status, created_at)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', ''),
    new.email,
    new.raw_user_meta_data ->> 'phone',
    coalesce(new.raw_user_meta_data ->> 'role', 'guardian'),
    case
      when coalesce(new.raw_user_meta_data ->> 'role', 'guardian') = 'guardian'
        then 'active'
      else 'pending'
    end,
    now()
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- PASSO 3 — Teste: este insert é o MESMO que o trigger executa.
-- Se ele falhar, a mensagem de erro mostra a constraint real do
-- problema (aí a causa não era trigger duplicado — me mande o erro).
-- Se passar, rode o delete logo abaixo para limpar e teste o
-- cadastro no site.

insert into public.profiles (id, name, email, phone, role, status, created_at)
values ('00000000-0000-0000-0000-000000000001',
        'Teste Trigger', 'teste-trigger@cognita.local',
        null, 'guardian', 'active', now());

delete from public.profiles
where id = '00000000-0000-0000-0000-000000000001';
