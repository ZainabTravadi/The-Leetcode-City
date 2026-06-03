import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { getAuthenticatedDeveloper } from "@/lib/arena";

async function rollItemDrops(sb: any, difficulty: string, devId: number): Promise<any[]> {
  const droppedItems: any[] = [];

  const getRandomItemByRarity = async (rarity: string): Promise<any> => {
    const { data } = await sb
      .from("arena_items")
      .select("*")
      .eq("rarity", rarity);
    
    if (data && data.length > 0) {
      return data[Math.floor(Math.random() * data.length)];
    }
    return null;
  };

  const roll = Math.random();

  if (difficulty === "easy") {
    // 100% -> 1 Common item
    const common = await getRandomItemByRarity("common");
    if (common) droppedItems.push(common);

    // 15% -> 1 Rare item
    if (roll < 0.15) {
      const rare = await getRandomItemByRarity("rare");
      if (rare) droppedItems.push(rare);
    }
  } else if (difficulty === "medium") {
    // 100% -> 1 Rare item
    const rare = await getRandomItemByRarity("rare");
    if (rare) droppedItems.push(rare);

    // 20% -> 1 Epic item
    if (roll < 0.20) {
      const epic = await getRandomItemByRarity("epic");
      if (epic) droppedItems.push(epic);
    }
    // 10% -> 2nd Rare item
    else if (roll < 0.30) {
      const rare2 = await getRandomItemByRarity("rare");
      if (rare2) droppedItems.push(rare2);
    }
  } else if (difficulty === "hard") {
    // 100% -> 1 Epic item
    const epic = await getRandomItemByRarity("epic");
    if (epic) droppedItems.push(epic);

    // 25% -> 1 Rare item
    if (roll < 0.25) {
      const rare = await getRandomItemByRarity("rare");
      if (rare) droppedItems.push(rare);
    }
    // 5% -> 1 Legendary item
    if (Math.random() < 0.05) {
      const legendary = await getRandomItemByRarity("legendary");
      if (legendary) droppedItems.push(legendary);
    }
    // 8% -> Epic + Rare bonus combo
    if (Math.random() < 0.08) {
      const epicBonus = await getRandomItemByRarity("epic");
      const rareBonus = await getRandomItemByRarity("rare");
      if (epicBonus) droppedItems.push(epicBonus);
      if (rareBonus) droppedItems.push(rareBonus);
    }
  }

  // Save dropped items to user's inventory
  for (const item of droppedItems) {
    const { data: existing } = await sb
      .from("arena_inventory")
      .select("id, quantity")
      .eq("user_id", devId)
      .eq("item_id", item.id)
      .maybeSingle();

    if (existing) {
      await sb
        .from("arena_inventory")
        .update({ quantity: existing.quantity + 1 })
        .eq("id", existing.id);
    } else {
      await sb
        .from("arena_inventory")
        .insert({
          user_id: devId,
          item_id: item.id,
          quantity: 1,
          is_equipped: false
        });
    }
  }

  return droppedItems;
}

export async function POST(request: NextRequest) {
  const dev = await getAuthenticatedDeveloper(request);
  if (!dev) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await request.json();
  const {
    challenge_id,
    problem_id,
    language,
    code_hash,
    code,
    status, // 'accepted', 'wrong_answer', 'tle', 'rte'
    tests_passed,
    tests_total,
    execution_time_ms
  } = body;

  if (!problem_id || !status) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  const sb = getSupabaseAdmin();

  // 1. Fetch challenge details (if linked)
  let challenge: any = null;
  let difficulty = "medium"; // fallback default
  let basePoints = 100;
  let baseXp = 10;

  if (challenge_id) {
    const { data: ch } = await sb
      .from("arena_challenges")
      .select("*")
      .eq("id", challenge_id)
      .maybeSingle();
    challenge = ch;
    if (challenge) {
      difficulty = challenge.difficulty;
      basePoints = challenge.reward_points || 100;
      baseXp = challenge.reward_xp || 10;
    }
  }

  // 2. Insert submission record
  const { error: insertError } = await sb
    .from("arena_submissions")
    .insert({
      user_id: dev.id,
      problem_id,
      challenge_id: challenge_id || null,
      language,
      code_hash,
      code,
      status,
      tests_passed: tests_passed || 0,
      tests_total: tests_total || 0,
      execution_time_ms: execution_time_ms || null,
      is_verified: false // server verification placeholder
    });

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }

  // 3. Process rewards only if status is accepted
  const isAccepted = status === "accepted";
  let grantedXp = 0;
  let grantedPoints = 0;
  let droppedItems: any[] = [];
  let isFirstSolve = false;

  if (isAccepted) {
    // Check if they already solved this challenge successfully before
    let priorSolved = false;
    if (challenge_id) {
      const { data: prior } = await sb
        .from("arena_submissions")
        .select("id")
        .eq("user_id", dev.id)
        .eq("challenge_id", challenge_id)
        .eq("status", "accepted")
        .limit(2); // this sub + previous sub
      priorSolved = prior ? prior.length > 1 : false;
    } else {
      const { data: prior } = await sb
        .from("arena_submissions")
        .select("id")
        .eq("user_id", dev.id)
        .eq("problem_id", problem_id)
        .eq("status", "accepted")
        .limit(2);
      priorSolved = prior ? prior.length > 1 : false;
    }

    isFirstSolve = !priorSolved;

    if (isFirstSolve) {
      // Calculate active buffs
      const { data: activeBuffs } = await sb
        .from("arena_active_buffs")
        .select("buff_type, buff_value")
        .eq("user_id", dev.id)
        .gt("expires_at", new Date().toISOString());

      let xpMultiplier = 1.0;
      let pointsMultiplier = 1.0;

      if (activeBuffs) {
        for (const buff of activeBuffs) {
          if (buff.buff_type === "xp_boost") {
            xpMultiplier += (buff.buff_value - 1.0);
          } else if (buff.buff_type === "reward_multiplier") {
            xpMultiplier += (buff.buff_value - 1.0);
            pointsMultiplier += (buff.buff_value - 1.0);
          }
        }
      }

      grantedXp = Math.round(baseXp * xpMultiplier);
      grantedPoints = Math.round(basePoints * pointsMultiplier);

      // Grant Points
      const { data: devRecord } = await sb
        .from("developers")
        .select("points")
        .eq("id", dev.id)
        .single();
      
      const newPoints = (devRecord?.points || 0) + grantedPoints;
      await sb
        .from("developers")
        .update({ points: newPoints })
        .eq("id", dev.id);

      // Grant XP via RPC
      const { data: xpData } = await sb.rpc("grant_xp", {
        p_developer_id: dev.id,
        p_source: `arena_${difficulty}`,
        p_amount: grantedXp
      });

      // Roll for items
      droppedItems = await rollItemDrops(sb, difficulty, dev.id);
    }
  }

  // 4. Update rating and streak statistics
  const { data: ratingRecord } = await sb
    .from("arena_ratings")
    .select("*")
    .eq("user_id", dev.id)
    .maybeSingle();

  const todayStr = new Date().toISOString().split("T")[0];
  let rating = ratingRecord?.rating ?? 1200;
  let problemsSolved = ratingRecord?.problems_solved ?? 0;
  let problemsAttempted = ratingRecord?.problems_attempted ?? 0;
  let currentStreak = ratingRecord?.current_streak ?? 0;
  let bestStreak = ratingRecord?.best_streak ?? 0;

  problemsAttempted += 1;

  if (isAccepted && isFirstSolve) {
    problemsSolved += 1;
    // Add rating ELO-like increments
    if (difficulty === "easy") rating += 10;
    else if (difficulty === "medium") rating += 20;
    else if (difficulty === "hard") rating += 40;

    // Manage streaks
    const lastSolvedDateStr = ratingRecord?.last_solved_at
      ? new Date(ratingRecord.last_solved_at).toISOString().split("T")[0]
      : null;
    const yesterdayStr = new Date(Date.now() - 24 * 3600 * 1000).toISOString().split("T")[0];

    if (lastSolvedDateStr !== todayStr) {
      if (lastSolvedDateStr === yesterdayStr) {
        currentStreak += 1;
      } else {
        currentStreak = 1;
      }
      if (currentStreak > bestStreak) {
        bestStreak = currentStreak;
      }
    }
  }

  await sb.from("arena_ratings").upsert({
    user_id: dev.id,
    rating,
    problems_solved: problemsSolved,
    problems_attempted: problemsAttempted,
    current_streak: currentStreak,
    best_streak: bestStreak,
    last_solved_at: isAccepted && isFirstSolve ? new Date().toISOString() : ratingRecord?.last_solved_at,
    updated_at: new Date().toISOString()
  });

  return NextResponse.json({
    status: "success",
    submission_status: status,
    is_first_solve: isFirstSolve,
    rewards: {
      points: grantedPoints,
      xp: grantedXp
    },
    dropped_items: droppedItems.map(item => ({
      id: item.id,
      name: item.name,
      slug: item.slug,
      rarity: item.rarity,
      item_type: item.item_type,
      icon_path: item.icon_path
    }))
  });
}

export const dynamic = "force-dynamic";
