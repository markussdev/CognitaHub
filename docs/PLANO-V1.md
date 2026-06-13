# Cognita Hub — Plano da Versão 1.0 (funcional, com Supabase)

Este plano transforma o protótipo estático atual em um produto funcional, mantendo o que já está bom (a modelagem do `docs/DATABASE.md`, o sistema de `data-mock`, a identidade visual) e substituindo o que é demonstrativo por fluxos reais. Está organizado em: decisões de arquitetura, setup do Supabase, autenticação, comportamento tela a tela, fases de execução, redesign e LGPD.

---

## 1. Decisões de arquitetura

**Manter HTML + CSS + JS puro.** Não migre para React/Vue agora. O projeto já tem 9 páginas prontas e o `supabase-js` funciona perfeitamente com JavaScript vanilla via import ESM. Migrar de framework jogaria fora semanas de trabalho para resolver um problema que você não tem.

**Adotar Vite como servidor de desenvolvimento e build.** Hoje você abre o `index.html` direto no navegador. Com Vite você ganha: variáveis de ambiente (`.env` para as chaves do Supabase), imports de módulos JS, recarga automática e build otimizado para deploy. A migração é trivial — Vite serve HTML multi-página nativamente.

**Estrutura de pastas alvo:**

```
cognita-hub/
├── index.html
├── pages/                  (mantém as 9 páginas)
├── css/
│   ├── tokens.css          (NOVO: variáveis de design)
│   ├── styles.css          (site público)
│   └── internal.css        (painéis)
├── js/
│   ├── lib/
│   │   ├── supabase.js     (NOVO: cliente único)
│   │   ├── auth.js         (NOVO: login, logout, guarda de rota)
│   │   └── format.js       (NOVO: datas, status em PT-BR)
│   ├── data/
│   │   ├── children.js     (NOVO: queries de crianças)
│   │   ├── cycles.js       (NOVO: ciclos e sessões)
│   │   └── admin.js        (NOVO: validações e matches)
│   ├── pages/
│   │   ├── responsavel.js  (NOVO: lógica do painel)
│   │   ├── tutor.js
│   │   ├── admin.js
│   │   └── atividades.js
│   └── app.js              (mantém: UI compartilhada, modo foco, menus)
├── .env                    (VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)
└── supabase/
    └── schema.sql          (o arquivo cognita-schema.sql deste plano)
```

**O truque que poupa retrabalho:** o seu `app.js` já preenche a tela lendo atributos `data-mock="crianca.nome"`. Mantenha exatamente esse mecanismo, mas troque a fonte: em vez de `window.cognitaMock`, monte o mesmo objeto a partir das queries do Supabase. As telas quase não mudam.

```js
// js/lib/supabase.js
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
)
```

A `anon key` pode aparecer no front sem problema — quem protege os dados é o Row Level Security (RLS) do banco, já incluído no schema.

---

## 2. Setup do Supabase (passo a passo)

1. Crie o projeto em supabase.com (região `sa-east-1`, São Paulo — menor latência para Belém).
2. Em **SQL Editor**, cole e execute o `cognita-schema.sql` inteiro. Ele cria as 13 tabelas, os enums, as políticas de RLS, os triggers e 6 atividades iniciais.
3. Em **Authentication → Providers**, deixe apenas **Email** habilitado. Em **Authentication → Email Templates**, traduza os e-mails para português.
4. Em **Authentication → Settings**, decida sobre "Confirm email". Para a v1.0 de uma competição, recomendo **desativar** a confirmação (cadastro entra direto) e ativar depois em produção real.
5. Crie o usuário admin manualmente: **Authentication → Users → Add user** (ex: `admin@cognitahub.org`), depois rode no SQL Editor:
   ```sql
   update public.profiles set role = 'admin', status = 'active'
   where email = 'admin@cognitahub.org';
   ```
6. Copie a `Project URL` e a `anon public key` (Settings → API) para o seu `.env`.

### Por que o schema é assim (decisões que importam)

**`profiles` em vez de `users`.** O Supabase já tem a tabela `auth.users` (senha, e-mail, sessão). A tabela `profiles` guarda só o que é seu: nome, telefone, papel, status. Um trigger cria o profile automaticamente no cadastro.

**O papel (role) mora no banco, nunca no front.** O login atual tem abas "Responsável / Tutor / Equipe" que o usuário escolhe. Isso some na v1.0: a pessoa só digita e-mail e senha, e o sistema descobre o papel consultando `profiles` e redireciona. Escolher o próprio papel é uma porta aberta para qualquer um "virar admin".

**Status como máquina de estados.** A criança caminha por `waiting_review → waiting_match → matched → active → completed`. Cada tela renderiza de acordo com o status — isso resolve o "tudo demonstrativo": a interface passa a refletir um estado real.

**`birth_date` em vez de `age`.** Idade armazenada envelhece errado; data de nascimento se calcula sempre certa.

**Mês do ciclo é calculado, não gravado.** A função `cycle_current_month()` deriva o mês a partir de `start_date`, então a barra de progresso nunca fica desatualizada.

**Minimização de dados (LGPD).** O tutor não enxerga telefone nem e-mail do responsável; o responsável vê do tutor apenas nome e formação (view `tutor_public`). O contato é mediado pela equipe — exatamente como o MVP descreve.

---

## 3. Autenticação e guarda de rotas

```js
// js/lib/auth.js
import { supabase } from './supabase.js'

export async function signUp({ email, password, name, phone, role }) {
  // role aqui só pode ser 'guardian' ou 'tutor' — o trigger no banco bloqueia 'admin'
  return supabase.auth.signUp({
    email, password,
    options: { data: { name, phone, role } }
  })
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) return { error }
  const { data: profile } = await supabase
    .from('profiles').select('role, status, name').eq('id', data.user.id).single()
  return { profile }
}

const HOME_BY_ROLE = {
  guardian: '/pages/responsavel.html',
  tutor: '/pages/tutor.html',
  admin: '/pages/admin.html',
}

export function redirectByRole(role) {
  window.location.href = HOME_BY_ROLE[role] ?? '/pages/login.html'
}

// Cole no topo de cada painel: expulsa quem não pertence à página
export async function requireRole(...allowed) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return window.location.replace('/pages/login.html')
  const { data: profile } = await supabase
    .from('profiles').select('role, status, name').eq('id', user.id).single()
  if (!allowed.includes(profile.role)) return redirectByRole(profile.role)
  return { user, profile }
}
```

Importante entender: a guarda de rota no front é **conveniência de navegação**, não segurança. Mesmo que alguém abra `admin.html` na marra, o RLS no banco devolve zero linhas para quem não é admin. A segurança real está no Postgres.

---

## 4. Comportamento de cada tela na v1.0

### `login.html`
Remove as abas de tipo de acesso. Um único formulário: e-mail + senha → `signIn()` → redireciona pelo papel vindo do banco. Erros em linguagem clara ("E-mail ou senha incorretos. Tente de novo."). Link "esqueci minha senha" usando `supabase.auth.resetPasswordForEmail()`. Se o `profiles.status` for `pending`, mostra uma tela intermediária: "Seu cadastro está em análise pela equipe Cognita" — em vez de deixar entrar num painel vazio.

### `cadastro-responsavel.html`
Vira um formulário em **3 etapas** (o HTML atual já sugere isso): (1) dados do responsável + criação de senha, (2) dados da criança + perfil pedagógico inicial, (3) consentimentos LGPD com checkboxes obrigatórios. No envio, em sequência: `signUp()` → `insert` em `children` (status `waiting_review`) → `insert` em `learning_profiles` → `insert` em `consents`. Tela final de sucesso explicando o que acontece agora ("A equipe analisa seu cadastro em até X dias e você receberá um e-mail"). Previsibilidade vale para os adultos também.

### `cadastro-tutor.html`
`signUp()` com role `tutor` → `insert` em `tutor_applications` (status `pending`) com formação, experiência, motivação e disponibilidade semanal (componente simples de dias × horários que grava o JSON). Tela de sucesso com expectativa clara do processo de validação.

### `responsavel.html` (painel do responsável)
No carregamento: `requireRole('guardian')`, busca a criança do responsável, o ciclo (se existir), a última sessão e a atividade sugerida. A tela tem **quatro estados**, dirigidos por `children.status`:

| Status | O que o painel mostra |
|---|---|
| `waiting_review` | "Cadastro em análise" + linha do tempo do processo |
| `waiting_match` | "Aprovado! Procurando o tutor ideal" + biblioteca de atividades liberada |
| `active` | O painel completo: próxima sessão, atividade da semana (vinda do `suggested_activity_id` do último registro do tutor), observações, barra de progresso do ciclo (mês X de 6), avanços por habilidade |
| `completed` | Resumo do ciclo + relatórios mensais |

O que hoje é mock vira: `sessaoAtual` → última linha de `sessions`; `atividadeSugerida` → join com `activities`; `ciclo.progressoPercentual` → `cycle_current_month / 6 * 100`.

### `tutor.html` (painel do tutor)
`requireRole('tutor')`. Se a `tutor_application` ainda está `pending`, mostra estado de espera. Aprovado e com ciclo: lista as crianças dos seus ciclos ativos (nome, foco, perfil pedagógico — sem contato da família), e o **formulário de registro de sessão** vira a peça central: data, tema, atividade usada (select da biblioteca), engajamento e dificuldade (escala 1–5 com botões grandes), resultado (`melhorou / estável / teve dificuldade`), observações, próximo passo e atividade sugerida para a semana. Salvar faz `insert` em `sessions` e a lista "últimos registros" recarrega. Uma vez por mês, o painel pede o relatório mensal (`reports`), destravando um banner "Relatório do mês X pendente".

### `perfil-crianca.html`
Recebe `?id=` da criança na URL. O RLS garante que só responsável dono, tutor do ciclo ativo e admin conseguem dados. Mostra `learning_profiles` (formatos preferidos, atenção, dificuldades, motivadores, o que evitar), plano atual do ciclo e último registro. O responsável pode **editar** o perfil pedagógico aqui (update em `learning_profiles`).

### `admin.html` (o motor do sistema)
`requireRole('admin')`. Quatro abas que viram funcionais:

1. **Validações** — duas filas: crianças com `waiting_review` e candidaturas de tutor `pending`. Botões Aprovar/Recusar fazem `update` de status (aprovar criança → `waiting_match`; aprovar tutor → `application approved` + `profile active`). Campo de anotação interna grava em `admin_notes`.
2. **Matches** — lista crianças `waiting_match` de um lado, tutores aprovados sem ciclo ativo do outro. Selecionar par + motivo → `insert` em `matches` → confirmar cria o `support_cycle` (start hoje, end +6 meses, status `planned`) e muda a criança para `matched`. Iniciar ciclo → `active` em ambos.
3. **Ciclos ativos** — tabela com criança, tutor, mês atual, data da última sessão, alerta visual se há mais de 10 dias sem registro (a query compara `max(sessions.date)` com hoje).
4. **Relatórios** — relatórios mensais entregues e pendentes por ciclo.

### `atividades.html`
Troca os cards fixos por `select * from activities` com filtros por habilidade, faixa etária e formato (os filtros que o `app.js` já tem, agora sobre dados reais). Leitura é pública — visitante vê, o que também funciona como vitrine do projeto. Admin ganha um formulário "Nova atividade".

### `index.html`
Continua estático (é institucional), mas os números do hero ("X crianças acompanhadas") podem vir de uma query agregada pública no futuro. Na v1.0, deixe estático e honesto.

---

## 5. Fases de execução (ordem recomendada)

A ordem importa: o painel admin vem **antes** dos painéis de tutor e responsável, porque sem aprovação e match não existe dado real para os outros painéis exibirem.

**Fase 0 — Fundação (1–2 dias).** Migrar para Vite, criar projeto Supabase, rodar o schema, criar o admin, montar `js/lib/supabase.js` e testar uma query qualquer no console.

**Fase 1 — Autenticação (2–3 dias).** `auth.js`, login real, logout no menu lateral (já existe o botão "Sair"), `requireRole` em todos os painéis, tela de "cadastro em análise".

**Fase 2 — Cadastros (3–4 dias).** Formulários de responsável e tutor gravando de verdade, com validação de campos, mensagens de erro claras e telas de sucesso. Ao final desta fase, dá para criar contas reais.

**Fase 3 — Painel admin (4–5 dias).** Validações, matches, criação de ciclo, anotações. Esta fase é o coração: é ela que faz o resto do sistema "acontecer".

**Fase 4 — Painel do tutor (3–4 dias).** Registro de sessão, lista de crianças, relatório mensal.

**Fase 5 — Painel do responsável (2–3 dias).** Quase só leitura: os quatro estados, atividade da semana, progresso. Editar perfil pedagógico em `perfil-crianca.html`.

**Fase 6 — Biblioteca de atividades (1–2 dias).** Listagem com filtros + cadastro pelo admin.

**Fase 7 — Redesign e acabamento (1 semana, em paralelo com 4–6 se houver mais de uma pessoa).** Seção 6 abaixo.

**Fase 8 — Deploy e teste de ponta a ponta (2 dias).** Vercel ou Netlify (build do Vite, variáveis de ambiente no painel da plataforma). Roteiro de teste: cadastrar responsável → cadastrar tutor → aprovar ambos no admin → criar match → iniciar ciclo → registrar 2 sessões como tutor → conferir tudo no painel do responsável.

Total realista: 4 a 6 semanas com dedicação parcial.

---

## 6. Redesign — por que parece "feio" e como consertar

O problema não é a identidade (azul `#141162`, dourado `#FFA800` e vinho `#540042` formam uma paleta forte e incomum). O problema é **falta de sistema**: são 5.700 linhas de CSS escritas por acréscimo, com dezenas de tamanhos de fonte, raios de borda e sombras diferentes. Nenhuma paleta sobrevive a isso. O conserto é criar um `tokens.css` e reescrever os componentes por cima dele — não recomeçar do zero.

```css
/* css/tokens.css */
:root {
  /* Cor — papel de cada uma, não só o valor */
  --ink: #230220;          /* texto forte */
  --ink-soft: #5b4a58;     /* texto secundário */
  --paper: #FFFFFC;        /* fundo de leitura */
  --paper-raised: #ffffff; /* cartões */
  --brand: #141162;        /* ação principal, links, marca */
  --brand-deep: #540042;   /* títulos de seção, contraste */
  --accent: #FFA800;       /* UM destaque por tela, nunca mais que isso */
  --ok: #1c7c54;  --warn: #b3590a;  --bad: #a3123a;

  /* Tipo — três tamanhos resolvem 90% das telas internas */
  --font-display: "Baloo 2", system-ui, sans-serif;   /* títulos: arredondada, acolhedora */
  --font-body: "Atkinson Hyperlegible", system-ui, sans-serif; /* corpo: feita para legibilidade */
  --text-sm: 0.875rem;  --text-md: 1rem;  --text-lg: 1.25rem;  --text-xl: 1.75rem;

  /* Espaço — escala única de 8px */
  --s1: 8px; --s2: 16px; --s3: 24px; --s4: 32px; --s6: 48px;

  /* Forma */
  --radius: 14px;
  --shadow: 0 2px 12px rgb(20 17 98 / 0.08);  /* UMA sombra para tudo */
  --border: 1px solid rgb(20 17 98 / 0.12);
}
```

Sugestão de fontes com propósito: **Atkinson Hyperlegible** (gratuita, criada pelo Braille Institute para máxima legibilidade — combina com a missão do projeto e rende um ótimo argumento na apresentação do Liga Jovem) para corpo, e **Baloo 2** para títulos, que conversa com o mascote sem infantilizar os painéis dos adultos.

Regras de disciplina que transformam a cara do produto:

1. **Um amarelo por tela.** O `--accent` marca a ação principal (o botão "Registrar sessão", a atividade da semana). Hoje o dourado aparece em tudo e por isso não destaca nada.
2. **Cartões idênticos.** Um único componente `.card` (mesmo raio, mesma sombra, mesmo padding) para painéis inteiros. A sensação de "feiura" em dashboards quase sempre vem de cartões com 5 variações acidentais.
3. **Status sempre com a mesma linguagem visual.** Um componente `.badge` com as cores semânticas (`--ok`, `--warn`, `--bad`) usado em criança, tutor, ciclo e sessão. Status é o conceito central do sistema — merece consistência absoluta.
4. **Hierarquia por tamanho e peso, não por cor.** Títulos em `--brand-deep`, corpo em `--ink`, apoio em `--ink-soft`. Pare aí.
5. **O Modo Foco que você já criou vira diferencial.** Estenda-o: além de reduzir estímulo visual, aumente espaçamento e esconda elementos secundários. Documente isso como recurso de acessibilidade cognitiva — é coerente com o público TEA e pontua em avaliação.
6. **Movimento quase zero nos painéis.** Para o público do projeto, previsibilidade > efeito. Apenas transições de 150ms em hover/focus e respeite `prefers-reduced-motion`.

Processo prático: crie `tokens.css`, importe antes dos outros dois arquivos, e migre uma tela por vez começando pelos painéis internos (são os mais usados e os mais bagunçados). Quando uma tela estiver 100% em tokens, delete as regras antigas dela do CSS velho. Em poucas telas o `internal.css` encolhe pela metade.

---

## 7. LGPD, segurança e ética (não é opcional neste projeto)

Vocês tratam **dados de crianças** e **dado sensível de saúde** (existência de diagnóstico de TEA). Isso coloca o projeto no nível mais protegido da LGPD (art. 11 e art. 14). O que a v1.0 precisa ter:

1. **Consentimento específico e registrado** — a tabela `consents` já guarda o quê, quando e qual versão dos termos. Escreva um termo de uso simples e versione (`terms_version: "1.0"`).
2. **Minimização** — colete só o necessário. O campo de diagnóstico aceita "prefiro não informar" e o sistema funciona igual sem essa resposta (já está assim no schema). Não peça laudo, CPF da criança nem foto na v1.0.
3. **Acesso por necessidade** — o RLS do schema implementa isso: tutor vê só as crianças dos próprios ciclos ativos e nunca o contato da família; responsável nunca vê outras crianças; anotações da equipe são invisíveis para todos os outros papéis.
4. **Direito de exclusão** — todas as FKs usam `on delete cascade` a partir do responsável, então apagar o usuário remove a criança e tudo derivado. Documente como o responsável solicita isso (um e-mail basta na v1.0).
5. **Aviso de limite ético em todas as áreas logadas** — o texto que já existe no readme ("não substitui acompanhamento clínico") deve aparecer no rodapé dos painéis, não só no site público.
6. **Senhas e segredos** — nunca commitar o `.env` (adicione ao `.gitignore`); a `service_role key` do Supabase não entra no front em hipótese alguma.

---

## 8. O que fica explicitamente fora da v1.0

Para proteger o escopo (o maior risco do projeto é querer demais): chat em tempo real, videochamada, upload de documentos, IA adaptativa, área da criança, gamificação, app mobile e notificações push. O e-mail transacional do próprio Supabase (confirmação, reset de senha) é o único "envio" da v1.0. Tudo isso já está corretamente listado como futuro nos seus docs — mantenha firme.

---

## Resumo executivo

A v1.0 é: **Vite + páginas que você já tem + supabase-js + o schema deste plano**. A sequência é fundação → auth → cadastros → admin → tutor → responsável → biblioteca → redesign por tokens → deploy. O painel admin é o coração e vem cedo. A interface melhora não recomeçando, mas impondo sistema (tokens, um accent por tela, cartões e badges únicos). E o RLS no banco — não o JavaScript — é quem protege os dados das crianças.
