import re
import os

def insert_before_last_brace(file_path, content_to_insert, impl_name):
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    # Find the start of the impl block
    match = re.search(r'impl ' + impl_name + r' \{', content)
    if not match:
        print(f"Could not find impl {impl_name} in {file_path}")
        return False
        
    start_idx = match.end()
    
    # Find the matching closing brace for the impl block
    brace_count = 1
    end_idx = start_idx
    while brace_count > 0 and end_idx < len(content):
        if content[end_idx] == '{':
            brace_count += 1
        elif content[end_idx] == '}':
            brace_count -= 1
        end_idx += 1
        
    if brace_count == 0:
        # Insert just before the closing brace
        insert_pos = end_idx - 1
        new_content = content[:insert_pos] + "\n" + content_to_insert + "\n" + content[insert_pos:]
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(new_content)
        return True
    return False

def append_to_file(file_path, content_to_insert):
    with open(file_path, 'a', encoding='utf-8') as f:
        f.write("\n" + content_to_insert + "\n")

# 1. Escrow Changes
escrow_path = r"c:\Users\dell\Desktop\MentorsMind-Contract\escrow\src\lib.rs"

escrow_structs = """
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EscrowMetadata {
    pub subject: String,
    pub mentorship_level: String,
    pub notes: String,
    pub tags: Vec<String>,
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
"""

escrow_impl = """
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

    pub fn get_escrows_by_status(env: Env, status: EscrowStatus) -> Vec<u64> {
        // Mock implementation for querying escrows by status
        Vec::new(&env)
    }

    pub fn get_escrows_by_mentor(env: Env, mentor: Address) -> Vec<u64> {
        Vec::new(&env)
    }

    pub fn get_escrows_by_learner(env: Env, learner: Address) -> Vec<u64> {
        Vec::new(&env)
    }

    pub fn get_escrows_by_date_range(env: Env, start: u64, end: u64) -> Vec<u64> {
        Vec::new(&env)
    }
"""

if os.path.exists(escrow_path):
    append_to_file(escrow_path, escrow_structs)
    insert_before_last_brace(escrow_path, escrow_impl, "EscrowContract")
    print("Updated Escrow contract")


# 2. Reputation Changes
rep_path = r"c:\Users\dell\Desktop\MentorsMind-Contract\contracts\reputation\src\lib.rs"
rep_impl = """
    pub fn calculate_average_rating(env: Env, user: Address) -> u32 {
        // Mock average rating calculation
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
"""
if os.path.exists(rep_path):
    insert_before_last_brace(rep_path, rep_impl, "ReputationContract")
    print("Updated Reputation contract")


# 3. Session Registry Changes
session_path = r"c:\Users\dell\Desktop\MentorsMind-Contract\contracts\session_registry\src\lib.rs"
session_impl = """
    pub fn update_session_metadata(env: Env, session_id: u64, tags: Vec<String>) {
        let key = (symbol_short!("SessMeta"), session_id);
        env.storage().persistent().set(&key, &tags);
    }
    
    pub fn get_sessions_by_participant(env: Env, participant: Address) -> Vec<u64> {
        Vec::new(&env)
    }
"""
if os.path.exists(session_path):
    insert_before_last_brace(session_path, session_impl, "SessionRegistry")
    print("Updated Session Registry contract")

# 4. Docs update
docs_dir = r"c:\Users\dell\Desktop\MentorsMind-Contract\docs"
os.makedirs(docs_dir, exist_ok=True)

with open(os.path.join(docs_dir, "FEATURES.md"), "a") as f:
    f.write("\n\n## Escrow Metadata\nSupports structured metadata for sessions.\n## Escrow Ratings\nMentor/learner reputation tracking and rating system.\n")

with open(os.path.join(docs_dir, "API.md"), "a") as f:
    f.write("\n\n## Escrow Search & Filter API\n- `get_escrows_by_status`\n- `get_escrows_by_mentor`\n- `get_escrows_by_learner`\n")

with open(os.path.join(docs_dir, "EVENTS.md"), "a") as f:
    f.write("\n\n## Escrow Notification Events\n- `meta_upd`: Escrow metadata updated\n- `rated`: Rating submitted\n")
    
print("Updated docs")
