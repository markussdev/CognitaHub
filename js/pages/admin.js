import { requireRole, signOut } from '../lib/auth.js'
import {
  getPendingTutors,
  getChildrenWaitingReview,
  approveTutor,
  rejectTutor,
  approveChild,
  requestChildRevision,
} from '../data/admin.js'

const session = await requireRole('admin')

const listChildren = document.querySelector('[data-list-children]')
const listTutors = document.querySelector('[data-list-tutors]')

document.querySelectorAll('[data-logout]').forEach((button) => {
  button.addEventListener('click', async (event) => {
    event.preventDefault()
    await signOut()
  })
})

// ---------- helpers de DOM (textContent sempre: dado de usuário, nunca innerHTML) ----------

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function initialsOf(name) {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  const first = parts[0][0]
  const last = parts.length > 1 ? parts[parts.length - 1][0] : ''
  return (first + last).toUpperCase()
}

function ageFrom(birthDate) {
  if (!birthDate) return null
  const birth = new Date(`${birthDate}T00:00:00`)
  if (Number.isNaN(birth.getTime())) return null
  const today = new Date()
  let age = today.getFullYear() - birth.getFullYear()
  const beforeBirthday =
    today.getMonth() < birth.getMonth() ||
    (today.getMonth() === birth.getMonth() && today.getDate() < birth.getDate())
  if (beforeBirthday) age -= 1
  return age
}

function asText(value) {
  if (value == null || value === '') return null
  if (Array.isArray(value)) return value.length ? value.join(', ') : null
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${item}`)
      .join(' · ')
  }
  return String(value)
}

function fact(label, value) {
  const text = asText(value)
  if (!text) return null
  const row = el('div')
  row.append(el('dt', null, label), el('dd', null, text))
  return row
}

function factList(facts) {
  const list = el('dl', 'card-facts')
  facts.forEach((row) => row && list.append(row))
  return list
}

function cardDetails(summaryLabel, facts) {
  const details = el('details', 'card-details')
  details.append(el('summary', null, summaryLabel), factList(facts))
  return details
}

// ---------- ações ----------

function bindAction(button, buttons, errorBox, action, confirmText) {
  button.addEventListener('click', async () => {
    if (confirmText && !window.confirm(confirmText)) return

    errorBox.hidden = true
    const originalLabel = button.textContent
    buttons.forEach((other) => {
      other.disabled = true
    })
    button.textContent = 'Salvando…'

    const { error } = await action()

    if (error) {
      buttons.forEach((other) => {
        other.disabled = false
      })
      button.textContent = originalLabel
      errorBox.textContent = 'Não foi possível concluir. Tente de novo.'
      errorBox.hidden = false
      return
    }

    await loadQueues()
  })
}

// ---------- cards ----------

function renderTutorCard(application) {
  const profile = application.profiles ?? {}
  const card = el('article', 'pipeline-card')

  const identity = el('div', 'card-id')
  const avatar = el('span', 'card-avatar blue', initialsOf(profile.name))
  avatar.setAttribute('aria-hidden', 'true')
  const heading = el('div')
  heading.append(el('p', 'app-kicker', 'Tutor'), el('h3', null, profile.name ?? 'Sem nome'))
  identity.append(avatar, heading)

  const summary = el('p', null, asText(application.formation) ?? 'Formação não informada')

  const tags = el('div', 'pipeline-tags')
  tags.setAttribute('aria-label', 'Estado da candidatura')
  tags.append(el('span', 'badge badge-warn', 'aguarda validação'))

  const details = cardDetails('Ver candidatura', [
    fact('Formação', application.formation),
    fact('Experiência', application.experience),
    fact('Motivação', application.motivation),
    fact('Disponibilidade', application.weekly_availability),
    fact('LinkedIn', application.linkedin),
    fact('E-mail', profile.email),
    fact('Telefone', profile.phone),
  ])

  const errorBox = el('p', 'card-error')
  errorBox.hidden = true

  const actions = el('div', 'row-actions')
  const approve = el('button', 'btn btn-primary btn-sm', 'Aprovar tutor')
  approve.type = 'button'
  const reject = el('button', 'btn btn-ghost btn-sm', 'Recusar')
  reject.type = 'button'
  actions.append(approve, reject)

  bindAction(approve, [approve, reject], errorBox, () =>
    approveTutor(application.tutor_id, session.user.id)
  )
  bindAction(
    reject,
    [approve, reject],
    errorBox,
    () => rejectTutor(application.tutor_id, session.user.id),
    `Recusar a candidatura de ${profile.name ?? 'este tutor'}? A pessoa não terá acesso ao painel.`
  )

  card.append(identity, summary, tags, details, errorBox, actions)
  return card
}

function renderChildCard(child) {
  const guardian = child.profiles ?? {}
  const learning = Array.isArray(child.learning_profiles)
    ? child.learning_profiles[0]
    : child.learning_profiles

  const card = el('article', 'pipeline-card')

  const identity = el('div', 'card-id')
  const avatar = el('span', 'card-avatar', initialsOf(child.name))
  avatar.setAttribute('aria-hidden', 'true')
  const heading = el('div')
  heading.append(el('p', 'app-kicker', 'Criança'), el('h3', null, child.name ?? 'Sem nome'))
  identity.append(avatar, heading)

  const age = ageFrom(child.birth_date)
  const summaryParts = [age != null ? `${age} anos` : null, asText(child.main_difficulties)]
  const summary = el('p', null, summaryParts.filter(Boolean).join(' · ') || 'Perfil em análise')

  const tags = el('div', 'pipeline-tags')
  tags.setAttribute('aria-label', 'Estado do cadastro')
  tags.append(el('span', 'badge badge-warn', 'aguarda análise'))

  const details = cardDetails('Ver perfil pedagógico', [
    fact('Ano escolar', child.school_year),
    fact('Diagnóstico formal', child.has_formal_diagnosis),
    fact('Principais dificuldades', child.main_difficulties),
    fact('Dificuldades em matemática', learning?.math_difficulties),
    fact('Formatos preferidos', learning?.preferred_formats),
    fact('Tempo de atenção', learning?.attention_span),
    fact('Pontos fortes', learning?.strengths),
    fact('Motivadores', learning?.motivators),
    fact('Evitar', learning?.avoidances),
    fact('Notas sensoriais', child.sensory_notes),
    fact('Rotina', child.routine_notes),
    fact('Responsável', guardian.name),
    fact('Contato', [guardian.email, guardian.phone].filter(Boolean).join(' · ')),
  ])

  const errorBox = el('p', 'card-error')
  errorBox.hidden = true

  const actions = el('div', 'row-actions')
  const approve = el('button', 'btn btn-primary btn-sm', 'Aprovar para pareamento')
  approve.type = 'button'
  const revise = el('button', 'btn btn-ghost btn-sm', 'Pedir revisão')
  revise.type = 'button'
  actions.append(approve, revise)

  bindAction(approve, [approve, revise], errorBox, () => approveChild(child.id))
  bindAction(
    revise,
    [approve, revise],
    errorBox,
    () => requestChildRevision(child.id),
    `Pedir revisão do cadastro de ${child.name ?? 'esta criança'}? O responsável deverá ajustar as informações.`
  )

  card.append(identity, summary, tags, details, errorBox, actions)
  return card
}

// ---------- listas, estados e contadores ----------

function buildEmptyState(message, withRetry) {
  const box = el('div', 'empty-state')
  box.append(
    el('strong', null, withRetry ? 'Algo deu errado' : 'Fila limpa'),
    el('span', null, message)
  )
  if (withRetry) {
    const retry = el('button', 'btn btn-ghost btn-sm', 'Tentar de novo')
    retry.type = 'button'
    retry.addEventListener('click', loadQueues)
    box.append(retry)
  }
  return box
}

function renderList(container, result, renderCard, messages) {
  if (result.error) {
    container.replaceChildren(buildEmptyState(messages.error, true))
    return
  }

  const rows = result.data ?? []
  if (!rows.length) {
    container.replaceChildren(buildEmptyState(messages.empty, false))
    return
  }

  container.replaceChildren(...rows.map(renderCard))
}

function setCount(selector, value) {
  document.querySelectorAll(selector).forEach((node) => {
    node.textContent = value == null ? '—' : String(value)
  })
}

function updateCounters(childrenResult, tutorsResult) {
  const childCount = childrenResult.error ? null : (childrenResult.data?.length ?? 0)
  const tutorCount = tutorsResult.error ? null : (tutorsResult.data?.length ?? 0)

  setCount('[data-count-children]', childCount)
  setCount('[data-count-tutors]', tutorCount)

  const total = childCount == null || tutorCount == null ? null : childCount + tutorCount
  setCount('[data-count-triagem]', total)
  setCount('[data-count-total]', total)

  const context = document.querySelector('[data-count-context]')
  if (context) {
    context.textContent =
      total == null
        ? 'pendências indisponíveis'
        : total === 1
          ? '1 pendência hoje'
          : `${total} pendências hoje`
  }
}

async function loadQueues() {
  ;[listChildren, listTutors].forEach((list) => {
    list.replaceChildren(el('div', 'skeleton'), el('div', 'skeleton'))
  })

  const [tutors, children] = await Promise.all([getPendingTutors(), getChildrenWaitingReview()])

  renderList(listTutors, tutors, renderTutorCard, {
    empty: 'Nenhuma candidatura aguardando validação.',
    error: 'Não foi possível carregar os tutores. Verifique a conexão.',
  })
  renderList(listChildren, children, renderChildCard, {
    empty: 'Nenhum cadastro de criança aguardando análise.',
    error: 'Não foi possível carregar as crianças. Verifique a conexão.',
  })

  updateCounters(children, tutors)
}

function fillAccount() {
  const name = session.profile.name || 'Equipe Cognita'
  const avatar = document.querySelector('[data-account-avatar]')
  const accountName = document.querySelector('[data-account-name]')
  const accountEmail = document.querySelector('[data-account-email]')

  if (avatar) avatar.textContent = initialsOf(name)
  if (accountName) accountName.textContent = name
  if (accountEmail) accountEmail.textContent = session.user.email ?? ''
}

if (session && listChildren && listTutors) {
  fillAccount()
  await loadQueues()
}
