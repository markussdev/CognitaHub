import { supabase } from '../lib/supabase.js'
import { signIn, redirectByRole } from '../lib/auth.js'
import { completePendingSignup } from '../lib/pending-signup.js'

const form = document.querySelector('[data-login-form]')
const emailInput = document.querySelector('[data-login-email]')
const passwordInput = document.querySelector('[data-login-password]')
const errorBox = document.querySelector('[data-login-error]')

function getStatusMessage(status) {
  const messages = {
    pending: 'Seu cadastro ainda está em análise pela equipe Cognita.',
    rejected: 'Seu cadastro não foi aprovado. Entre em contato com a equipe Cognita.',
    inactive: 'Seu acesso está inativo. Entre em contato com a equipe Cognita.',
  }

  return messages[status] ?? 'Seu acesso ainda não está liberado.'
}

async function getProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('role, status, name')
    .eq('id', userId)
    .single()

  if (error) {
    console.error('Erro ao buscar perfil:', error)
    return null
  }

  return data
}

async function redirectExistingSession() {
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return

  // Completa cadastro pendente (confirmação de email ligada ou falha anterior).
  const pendingResult = await completePendingSignup(user)

  if (pendingResult.error) {
    // Não deixa o responsável entrar no painel sem a criança gravada.
    await supabase.auth.signOut()
    errorBox.textContent =
      'Sua conta foi acessada, mas não foi possível concluir o cadastro. Tente novamente ou fale com a equipe Cognita.'
    return
  }

  const profile = await getProfile(user.id)

  if (!profile) {
    await supabase.auth.signOut()
    return
  }

  if (profile.status !== 'active') {
    await supabase.auth.signOut()
    errorBox.textContent = getStatusMessage(profile.status)
    return
  }

  redirectByRole(profile.role)
}

await redirectExistingSession()

form.addEventListener('submit', async (event) => {
  event.preventDefault()

  errorBox.textContent = ''

  const email = emailInput.value.trim()
  const password = passwordInput.value

  const { user, profile, error } = await signIn(email, password)

  if (error || !profile) {
    errorBox.textContent = 'E-mail ou senha incorretos. Tente novamente.'
    return
  }

  // Completa cadastro pendente ANTES da checagem de status: o tutor fica
  // "pending" até a aprovação, mas a candidatura precisa ser gravada.
  const pendingResult = await completePendingSignup(user)

  if (pendingResult.error) {
    // Não deixa o responsável entrar no painel sem a criança gravada.
    await supabase.auth.signOut()
    errorBox.textContent =
      'Sua conta foi acessada, mas não foi possível concluir o cadastro. Tente novamente ou fale com a equipe Cognita.'
    return
  }

  if (profile.status !== 'active') {
    await supabase.auth.signOut()
    errorBox.textContent = getStatusMessage(profile.status)
    return
  }

  redirectByRole(profile.role)
})
