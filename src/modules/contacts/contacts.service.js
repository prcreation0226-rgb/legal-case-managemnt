const prisma = require('../../config/db');

/**
 * Calculate linked matters count for a given contact/client ID.
 */
async function getLinkedMattersCount(clientId) {
  if (!clientId) return 0;
  const countAsPrimary = await prisma.matter.count({
    where: { client_id: clientId }
  });

  // Also check matters where client is listed in parties_data JSON
  const allMatters = await prisma.matter.findMany({
    select: { id: true, parties_data: true }
  });

  let countInPartiesData = 0;
  allMatters.forEach(m => {
    if (m.parties_data) {
      try {
        const parties = typeof m.parties_data === 'string' ? JSON.parse(m.parties_data) : m.parties_data;
        if (Array.isArray(parties)) {
          const match = parties.some(p => String(p.client_id) === String(clientId) || String(p.contact_id) === String(clientId));
          if (match) countInPartiesData++;
        }
      } catch (e) { /* ignore */ }
    }
  });

  return countAsPrimary + countInPartiesData;
}

const getAll = async (query = {}, user) => {
  const { page = 1, limit = 10, q = '', party_type = 'All' } = query;
  const take = parseInt(limit, 10);
  const skip = (parseInt(page) - 1) * take;

  const where = {};

  if (party_type && party_type !== 'All') {
    where.party_type = party_type;
  }

  if (q && q.trim()) {
    const s = q.trim();
    where.OR = [
      { full_name: { contains: s } },
      { email: { contains: s } },
      { phone: { contains: s } },
      { organization_name: { contains: s } }
    ];
  }

  const [total, contacts] = await Promise.all([
    prisma.client.count({ where }),
    prisma.client.findMany({
      where,
      skip,
      take,
      orderBy: { updated_at: 'desc' }
    })
  ]);

  // Enrich with linked matters count
  const enriched = await Promise.all(
    contacts.map(async c => {
      const linkedCount = await getLinkedMattersCount(c.id);
      return {
        ...c,
        linked_matters_count: linkedCount
      };
    })
  );

  return {
    contacts: enriched,
    total,
    page: parseInt(page, 10),
    limit: take,
    total_pages: Math.ceil(total / take)
  };
};

const search = async (q = '', user) => {
  if (!q || !q.trim()) {
    const contacts = await prisma.client.findMany({
      take: 20,
      orderBy: { updated_at: 'desc' }
    });
    return await Promise.all(
      contacts.map(async c => ({
        ...c,
        linked_matters_count: await getLinkedMattersCount(c.id)
      }))
    );
  }

  const s = q.trim();
  const contacts = await prisma.client.findMany({
    where: {
      OR: [
        { full_name: { contains: s } },
        { email: { contains: s } },
        { phone: { contains: s } },
        { organization_name: { contains: s } }
      ]
    },
    take: 30,
    orderBy: { updated_at: 'desc' }
  });

  return await Promise.all(
    contacts.map(async c => ({
      ...c,
      linked_matters_count: await getLinkedMattersCount(c.id)
    }))
  );
};

const getById = async (id, user) => {
  const contact = await prisma.client.findUnique({
    where: { id: parseInt(id, 10) }
  });
  if (!contact) return null;
  const linkedCount = await getLinkedMattersCount(contact.id);
  return {
    ...contact,
    linked_matters_count: linkedCount
  };
};

/**
 * Find existing duplicate contact by Phone, Email, or Government ID/Driver License.
 * Priority: 1. Phone, 2. Email, 3. Driver License / SSN / Government ID
 */
const findDuplicateContact = async (data = {}) => {
  const cleanPhone = (data.phone || data.retaining_client_phone || '').trim();
  const cleanEmail = (data.email || data.retaining_client_email || '').trim();
  const cleanGovId = (data.government_id || data.retaining_client_gov_id || data.driver_license || data.ssn || '').trim();

  // 1. Phone check (Highest Priority)
  if (cleanPhone) {
    const existing = await prisma.client.findFirst({
      where: { phone: { equals: cleanPhone } }
    });
    if (existing) {
      return {
        duplicate: true,
        matchedField: 'phone',
        message: 'A contact with this phone number already exists.',
        contact: {
          id: existing.id,
          name: existing.full_name,
          full_name: existing.full_name,
          phone: existing.phone,
          email: existing.email && !existing.email.includes('@vktori.internal') ? existing.email : '',
          party_role: existing.party_role,
          party_type: existing.party_type,
          government_id: existing.government_id
        }
      };
    }
  }

  // 2. Email check
  if (cleanEmail && !cleanEmail.includes('@vktori.internal')) {
    const existing = await prisma.client.findFirst({
      where: { email: { equals: cleanEmail } }
    });
    if (existing) {
      return {
        duplicate: true,
        matchedField: 'email',
        message: 'A contact with this email address already exists.',
        contact: {
          id: existing.id,
          name: existing.full_name,
          full_name: existing.full_name,
          phone: existing.phone,
          email: existing.email,
          party_role: existing.party_role,
          party_type: existing.party_type,
          government_id: existing.government_id
        }
      };
    }
  }

  // 3. Driver License / Government ID / SSN check
  if (cleanGovId) {
    const existing = await prisma.client.findFirst({
      where: { government_id: { equals: cleanGovId } }
    });
    if (existing) {
      return {
        duplicate: true,
        matchedField: 'government_id',
        message: 'A contact with this Driver License / Government ID / SSN already exists.',
        contact: {
          id: existing.id,
          name: existing.full_name,
          full_name: existing.full_name,
          phone: existing.phone,
          email: existing.email && !existing.email.includes('@vktori.internal') ? existing.email : '',
          party_role: existing.party_role,
          party_type: existing.party_type,
          government_id: existing.government_id
        }
      };
    }
  }

  return null;
};

const create = async (data, user) => {
  const { full_name, email, phone, party_type = 'Person', organization_name, address_line_1, city, state, postal_code, notes } = data;

  if (!full_name || !full_name.trim()) {
    const err = new Error('Contact Name is required');
    err.statusCode = 400;
    throw err;
  }

  const cleanName = full_name.trim();
  const cleanEmail = email ? email.trim() : '';
  const cleanPhone = phone ? phone.trim() : '';

  // Duplicate Check Rule (Priority: Phone -> Email -> GovID)
  if (!data.bypass_duplicate) {
    const duplicateMatch = await findDuplicateContact(data);
    if (duplicateMatch) {
      return duplicateMatch;
    }
  }

  // Create new contact master entry
  const newContact = await prisma.client.create({
    data: {
      full_name: cleanName,
      email: cleanEmail || `contact_${Date.now()}@vktori.internal`,
      phone: cleanPhone || null,
      party_type: party_type || 'Person',
      organization_name: organization_name || (party_type === 'Organization' ? cleanName : null),
      address_line_1: address_line_1 || null,
      city: city || null,
      state: state || null,
      postal_code: postal_code || null,
      notes: notes || null
    }
  });

  // Log activity
  await prisma.activity.create({
    data: {
      entity_type: 'contact',
      entity_id: newContact.id,
      action: 'contact_created',
      description: `New contact master entry created: ${newContact.full_name}`,
      actor_user_id: user?.id || null
    }
  });

  return {
    ...newContact,
    linked_matters_count: 0,
    is_duplicate: false
  };
};

const update = async (id, data, user) => {
  const contactId = parseInt(id, 10);
  const existing = await prisma.client.findUnique({ where: { id: contactId } });
  if (!existing) {
    const err = new Error('Contact not found');
    err.statusCode = 404;
    throw err;
  }

  const { full_name, email, phone, party_type, organization_name, address_line_1, city, state, postal_code, notes } = data;

  const updateData = {};
  if (full_name !== undefined) updateData.full_name = full_name.trim();
  if (email !== undefined) updateData.email = email.trim();
  if (phone !== undefined) updateData.phone = phone.trim();
  if (party_type !== undefined) updateData.party_type = party_type;
  if (organization_name !== undefined) updateData.organization_name = organization_name;
  if (address_line_1 !== undefined) updateData.address_line_1 = address_line_1;
  if (city !== undefined) updateData.city = city;
  if (state !== undefined) updateData.state = state;
  if (postal_code !== undefined) updateData.postal_code = postal_code;
  if (notes !== undefined) updateData.notes = notes;

  const updated = await prisma.client.update({
    where: { id: contactId },
    data: updateData
  });

  // Log activity
  await prisma.activity.create({
    data: {
      entity_type: 'contact',
      entity_id: updated.id,
      action: 'contact_updated',
      description: `Contact master entry updated: ${updated.full_name}`,
      actor_user_id: user?.id || null
    }
  });

  const linkedCount = await getLinkedMattersCount(updated.id);
  return {
    ...updated,
    linked_matters_count: linkedCount
  };
};

const remove = async (id, user) => {
  const contactId = parseInt(id, 10);
  const linkedCount = await getLinkedMattersCount(contactId);

  if (linkedCount > 0) {
    const err = new Error(`Cannot delete contact: Contact is linked to ${linkedCount} active matter(s). Reusable contacts with active matter links are preserved to maintain referential integrity.`);
    err.statusCode = 400;
    throw err;
  }

  await prisma.client.delete({ where: { id: contactId } });
  return { success: true, deleted_id: contactId };
};

const crypto = require('crypto');
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '12345678901234567890123456789012'; // 32 chars
const IV_LENGTH = 16;

const encryptSensitiveValue = (text) => {
  if (!text) return text;
  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
    let encrypted = cipher.update(String(text));
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
  } catch(e) {
    return text;
  }
};

const decryptSensitiveValue = (text) => {
  if (!text || !text.includes(':')) return text;
  try {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY.padEnd(32).slice(0, 32)), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch(e) {
    return text;
  }
};

const maskSensitiveValue = (val) => {
  if (!val) return '';
  const str = String(val);
  if (str.length <= 4) return '••••';
  return `••••-••••-${str.slice(-4)}`;
};

module.exports = {
  getAll,
  search,
  getById,
  create,
  update,
  remove,
  getLinkedMattersCount,
  findDuplicateContact,
  encryptSensitiveValue,
  decryptSensitiveValue,
  maskSensitiveValue
};
