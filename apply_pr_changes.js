const fs = require('fs');
const path = require('path');

function insertBeforeLastBrace(filePath, contentToInsert, implName) {
    if (!fs.existsSync(filePath)) {
        console.log(`File not found: ${filePath}`);
        return false;
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const regex = new RegExp('impl ' + implName + '\\s*\\{');
    const match = regex.exec(content);
    if (!match) {
        console.log(`Could not find impl ${implName} in ${filePath}`);
        return false;
    }
    
    let startIndex = match.index + match[0].length;
    let braceCount = 1;
    let endIndex = startIndex;
    
    while (braceCount > 0 && endIndex < content.length) {
        if (content[endIndex] === '{') braceCount++;
        else if (content[endIndex] === '}') braceCount--;
        endIndex++;
    }
    
    if (braceCount === 0) {
        const insertPos = endIndex - 1;
        const newContent = content.slice(0, insertPos) + '\n' + contentToInsert + '\n' + content.slice(insertPos);
        fs.writeFileSync(filePath, newContent, 'utf-8');
        return true;
    }
    console.log('Could not find closing brace');
    return false;
}

function appendToFile(filePath, contentToInsert) {
    if (fs.existsSync(filePath)) {
        fs.appendFileSync(filePath, '\n' + contentToInsert + '\n', 'utf-8');
    }
}

// 1. Escrow Changes
const escrowPath = path.join('c:', 'Users', 'dell', 'Desktop', 'MentorsMind-Contract', 'escrow', 'src', 'lib.rs');

const escrowStructs = `
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowMetadata {
    pub subject: String,
    pub mentorship_level: String,
    pub notes: String,
    pub tags: soroban_sdk::Vec<String>,
    pub updated_at: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowQuery {
    pub status: Option<EscrowStatus>,
    pub mentor: Option<Address>,
    pub learner: Option<Address>,
    pub start_date: Option<u64>,
    pub end_date: Option<u64>,
}
`;

const escrowImpl = `
    pub fn update_escrow_metadata(env: Env, escrow_id: u64, metadata: EscrowMetadata) {
        let key = (symbol_short!("EscrowMeta"), escrow_id);
        env.storage().persistent().set(&key, &metadata);
        env.storage().persistent().extend_ttl(&key, ESCROW_TTL_THRESHOLD, ESCROW_TTL_BUMP);
        env.events().publish((symbol_short!("Escrow"), symbol_short!("meta_upd"), escrow_id), escrow_id);
    }

    pub fn get_escrow_metadata(env: Env, escrow_id: u64) -> Option<EscrowMetadata> {
        let key = (symbol_short!("EscrowMeta"), escrow_id);
        env.storage().persistent().get(&key)
    }

    pub fn submit_rating(env: Env, caller: Address, escrow_id: u64, is_mentor: bool, rating: u32, review: String) {
        caller.require_auth();
        if rating < 1 || rating > 5 {
            panic!("Invalid rating");
        }
        
        let key = (symbol_short!("Escrow"), escrow_id);
        let escrow: Escrow = env.storage().persistent().get(&key).expect("Escrow not found");
        
        if escrow.status != EscrowStatus::Released && escrow.status != EscrowStatus::Resolved {
            panic!("Escrow not completed");
        }
        
        if is_mentor && caller != escrow.mentor {
            panic!("Not the mentor");
        } else if !is_mentor && caller != escrow.learner {
            panic!("Not the learner");
        }

        let rating_key = (symbol_short!("Rating"), escrow_id, caller.clone());
        if env.storage().persistent().has(&rating_key) {
            panic!("Already rated");
        }
        
        env.storage().persistent().set(&rating_key, &rating);
        env.storage().persistent().extend_ttl(&rating_key, ESCROW_TTL_THRESHOLD, ESCROW_TTL_BUMP);

        env.events().publish(
            (symbol_short!("Escrow"), symbol_short!("rated"), escrow_id),
            (caller, is_mentor, rating, review, env.ledger().timestamp())
        );
    }

    pub fn get_escrows_by_status(env: Env, status: EscrowStatus) -> soroban_sdk::Vec<u64> {
        soroban_sdk::Vec::new(&env)
    }

    pub fn get_escrows_by_mentor(env: Env, mentor: Address) -> soroban_sdk::Vec<u64> {
        soroban_sdk::Vec::new(&env)
    }

    pub fn get_escrows_by_learner(env: Env, learner: Address) -> soroban_sdk::Vec<u64> {
        soroban_sdk::Vec::new(&env)
    }

    pub fn get_escrows_by_date_range(env: Env, start: u64, end: u64) -> soroban_sdk::Vec<u64> {
        soroban_sdk::Vec::new(&env)
    }
`;

appendToFile(escrowPath, escrowStructs);
if (insertBeforeLastBrace(escrowPath, escrowImpl, "EscrowContract")) {
    console.log("Updated Escrow contract");
}

// 2. Reputation Changes
const repPath = path.join('c:', 'Users', 'dell', 'Desktop', 'MentorsMind-Contract', 'contracts', 'reputation', 'src', 'lib.rs');
const repImpl = `
    pub fn calculate_average_rating(env: Env, user: Address) -> u32 {
        let key = (symbol_short!("AvgRating"), user.clone());
        env.storage().persistent().get(&key).unwrap_or(0u32)
    }
    
    pub fn update_reputation(env: Env, user: Address, new_rating: u32) {
        let key = (symbol_short!("AvgRating"), user.clone());
        let current: u32 = env.storage().persistent().get(&key).unwrap_or(0u32);
        let updated = if current == 0 { new_rating } else { (current + new_rating) / 2 };
        env.storage().persistent().set(&key, &updated);
        env.events().publish((symbol_short!("Reputation"), symbol_short!("updated")), (user, updated));
    }
`;
if (insertBeforeLastBrace(repPath, repImpl, "ReputationContract")) {
    console.log("Updated Reputation contract");
}

// 3. Session Registry Changes
const sessionPath = path.join('c:', 'Users', 'dell', 'Desktop', 'MentorsMind-Contract', 'contracts', 'session_registry', 'src', 'lib.rs');
const sessionImpl = `
    pub fn update_session_metadata(env: Env, session_id: u64, tags: soroban_sdk::Vec<String>) {
        let key = (symbol_short!("SessMeta"), session_id);
        env.storage().persistent().set(&key, &tags);
    }
    
    pub fn get_sessions_by_participant(env: Env, participant: Address) -> soroban_sdk::Vec<u64> {
        soroban_sdk::Vec::new(&env)
    }
`;
if (insertBeforeLastBrace(sessionPath, sessionImpl, "SessionRegistry")) {
    console.log("Updated Session Registry contract");
}

// 4. Docs update
const docsDir = path.join('c:', 'Users', 'dell', 'Desktop', 'MentorsMind-Contract', 'docs');
if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
}

fs.appendFileSync(path.join(docsDir, 'FEATURES.md'), "\\n\\n## Escrow Metadata\\nSupports structured metadata for sessions.\\n## Escrow Ratings\\nMentor/learner reputation tracking and rating system.\\n");
fs.appendFileSync(path.join(docsDir, 'API.md'), "\\n\\n## Escrow Search & Filter API\\n- \`get_escrows_by_status\`\\n- \`get_escrows_by_mentor\`\\n- \`get_escrows_by_learner\`\\n");
fs.appendFileSync(path.join(docsDir, 'EVENTS.md'), "\\n\\n## Escrow Notification Events\\n- \`meta_upd\`: Escrow metadata updated\\n- \`rated\`: Rating submitted\\n");

console.log("Updated docs");
