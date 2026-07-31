const prisma = require('../../config/db');

const getAll = async (query) => {
  const { status, matter_type, page = 1, limit = 10 } = query;
  
  const where = {};
  if (status) where.status = status;
  if (matter_type) where.matter_type = matter_type;

  const take = parseInt(limit);
  const skip = (parseInt(page) - 1) * take;

  return await prisma.lead.findMany({
    where,
    skip,
    take,
    orderBy: { created_at: 'desc' },
  });
};

const getById = async (id) => {
  return await prisma.lead.findUnique({ 
    where: { id: parseInt(id) },
    include: {
      created_by: {
        select: { id: true, full_name: true }
      }
    }
  });
};

const create = async (data) => {
  const lead = await prisma.lead.create({ data });
  
  // Log activity
  await prisma.activity.create({
    data: {
      entity_type: 'lead',
      entity_id: lead.id,
      action: 'created',
      description: `Lead created for ${lead.full_name}`,
    }
  });

  return lead;
};

const createFromPublicConsultation = async (body) => {
  const full_name = String(body?.full_name || '').trim();
  const email = String(body?.email || '').trim();
  const phoneRaw = String(body?.phone ?? '').trim();
  const preferred_date = String(body?.preferred_date || '').trim();
  const matter_type = String(body?.matter_type || '').trim();
  const message = String(body?.message || '').trim();

  if (!full_name || !email || !preferred_date || !matter_type || !message) {
    const err = new Error('Full name, email, preferred date, matter type, and matter overview are required');
    err.statusCode = 400;
    throw err;
  }

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailOk) {
    const err = new Error('Valid email is required');
    err.statusCode = 400;
    throw err;
  }

  const notesLines = [
    'Channel: website book consultation',
    `Preferred consultation date: ${preferred_date}`,
  ];

  return create({
    full_name,
    email,
    phone: phoneRaw || null,
    matter_type,
    practice_area: matter_type,
    source: 'website',
    message,
    notes: notesLines.join('\n'),
    status: 'new',
    created_by_user_id: null,
  });
};

const createFromPublicInquiry = async (body) => {
  const full_name = String(body?.full_name || '').trim();
  const email = String(body?.email || '').trim();
  const phoneRaw = String(body?.phone ?? '').trim();
  const preferred_contact_method = String(body?.preferred_contact_method || 'email').trim();
  const preferred_language = String(body?.preferred_language || 'English').trim();
  const city = String(body?.city || '').trim();
  const zip_code = String(body?.zip_code || '').trim();
  const matter_type = String(body?.matter_type || '').trim();
  const incident_date = String(body?.incident_date || '').trim();
  const is_ongoing = Boolean(body?.is_ongoing);
  const incident_location = String(body?.incident_location || '').trim();
  const message = String(body?.message || '').trim();
  const parties_involved = String(body?.parties_involved || '').trim();
  const has_court_date = String(body?.has_court_date || 'No').trim() === 'Yes' || Boolean(body?.has_court_date === true);
  const court_date = String(body?.court_date || '').trim();
  const court_date_description = String(body?.court_date_description || '').trim();
  const has_court_papers = String(body?.has_court_papers || 'No').trim() === 'Yes' || Boolean(body?.has_court_papers === true);
  const currently_represented = String(body?.currently_represented || 'No').trim() === 'Yes' || Boolean(body?.currently_represented === true);
  const referral_source = String(body?.referral_source || '').trim();
  const disclaimer_accepted = Boolean(body?.disclaimer_accepted);

  if (!full_name || (!email && !phoneRaw) || !message) {
    const err = new Error('Full name, contact details, and matter narrative are required');
    err.statusCode = 400;
    throw err;
  }

  if (email) {
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!emailOk) {
      const err = new Error('Valid email address is required');
      err.statusCode = 400;
      throw err;
    }
  }

  const notesLines = [
    `--- PUBLIC INTAKE UNIVERSAL VARIABLES ---`,
    `Preferred Language: ${preferred_language}`,
    `Preferred Contact Method: ${preferred_contact_method}`,
    `City/ZIP: ${city}${zip_code ? `, ${zip_code}` : ''}`,
    `When Happened: ${is_ongoing ? 'Ongoing Incident' : (incident_date || 'N/A')}`,
    `Where Happened: ${incident_location || 'N/A'}`,
    `Parties Involved: ${parties_involved || 'None listed'}`,
    `Court Date / Hearing Deadline: ${has_court_date ? `YES (${court_date || 'Date unstated'}) - ${court_date_description}` : 'No'}`,
    `Court / Agency Papers Received: ${has_court_papers ? 'YES' : 'No'}`,
    `Currently Represented by Attorney: ${currently_represented ? 'YES' : 'No'}`,
    `Referral Channel: ${referral_source || 'Website'}`,
    `Disclaimers Accepted: ${disclaimer_accepted ? 'YES' : 'No'}`,
  ];

  if (has_court_date) {
    notesLines.unshift(`🚨 [URGENT: HEARING / COURT DEADLINE DISCLOSED] 🚨`);
  }

  return create({
    full_name,
    email: email || `${phoneRaw.replace(/\D/g, '') || Date.now()}@intake.placeholder`,
    phone: phoneRaw || null,
    matter_type: matter_type || 'General Inquiry',
    practice_area: matter_type || 'General Inquiry',
    source: referral_source || 'website_inquiry',
    message,
    notes: notesLines.join('\n'),
    status: 'new',
    created_by_user_id: null,
  });
};

const update = async (id, data) => {
  const lead = await prisma.lead.update({
    where: { id: parseInt(id) },
    data,
  });

  // Log activity
  await prisma.activity.create({
    data: {
      entity_type: 'lead',
      entity_id: lead.id,
      action: 'updated',
      description: `Lead updated: status changed to ${lead.status}`,
    }
  });

  return lead;
};

const remove = async (id) => {
  return await prisma.lead.delete({ where: { id: parseInt(id) } });
};

const convertToClient = async (leadId, createdByUserId) => {
  const lead = await prisma.lead.findUnique({ where: { id: parseInt(leadId) } });
  
  if (!lead) throw new Error('Lead not found');

  // Transaction to convert lead to client
  return await prisma.$transaction(async (tx) => {
    // 1. Create client
    const client = await tx.client.create({
      data: {
        full_name: lead.full_name,
        email: lead.email,
        phone: lead.phone,
        notes: `Converted from lead. Original message: ${lead.message}`,
      }
    });

    // 2. Update lead
    await tx.lead.update({
      where: { id: lead.id },
      data: { 
        status: 'retained',
        converted_client_id: client.id 
      }
    });

    // 3. Log activity
    await tx.activity.create({
      data: {
        entity_type: 'client',
        entity_id: client.id,
        action: 'converted_from_lead',
        actor_user_id: createdByUserId,
        description: `Client created from Lead #${lead.id}`,
      }
    });

    return client;
  });
};


module.exports = {
  getAll,
  getById,
  create,
  createFromPublicConsultation,
  createFromPublicInquiry,
  update,
  remove,
  convertToClient,
};
