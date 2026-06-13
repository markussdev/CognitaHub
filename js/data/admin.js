import { supabase } from '../lib/supabase.js'

// Update que falha alto quando o RLS filtra tudo: sem o .select(), o
// PostgREST devolve "sucesso" mesmo com zero linhas alteradas e o botão
// funcionaria sem mudar nada no banco.
async function updateOne(table, patch, column, value) {
  const { data, error } = await supabase
    .from(table)
    .update(patch)
    .eq(column, value)
    .select('id')

  if (error) return { error }

  if (!data?.length) {
    return {
      error: new Error(`Nenhuma linha alterada em ${table} — confira as policies de admin.`),
    }
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

  const application = await updateOne(
    'tutor_applications',
    { status: 'approved', ...reviewed },
    'tutor_id',
    tutorId
  )
  if (application.error) return application

  const profile = await updateOne('profiles', { status: 'active' }, 'id', tutorId)

  if (profile.error) {
    await updateOne(
      'tutor_applications',
      { status: 'pending', reviewed_by: null, reviewed_at: null },
      'tutor_id',
      tutorId
    )
    return profile
  }

  return profile
}

export async function rejectTutor(tutorId, adminId) {
  const reviewed = { reviewed_by: adminId, reviewed_at: new Date().toISOString() }

  const application = await updateOne(
    'tutor_applications',
    { status: 'rejected', ...reviewed },
    'tutor_id',
    tutorId
  )
  if (application.error) return application

  const profile = await updateOne('profiles', { status: 'rejected' }, 'id', tutorId)

  if (profile.error) {
    await updateOne(
      'tutor_applications',
      { status: 'pending', reviewed_by: null, reviewed_at: null },
      'tutor_id',
      tutorId
    )
    return profile
  }

  return profile
}

export function approveChild(childId) {
  return updateOne('children', { status: 'waiting_match' }, 'id', childId)
}

// "Pedir revisão" ≠ recusar: o cadastro volta pro responsável ajustar.
export function requestChildRevision(childId) {
  return updateOne('children', { status: 'revision_requested' }, 'id', childId)
}
