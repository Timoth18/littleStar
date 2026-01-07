import express from "express";
import bodyParser from "body-parser";
import { supabase, supabaseUser } from "./db.js";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
const port = 3000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static("public"));
app.use(express.json());
app.use(cookieParser());
app.set("view engine", "ejs");


/* ------------------------------
Utility: Ensure Scores Exist for a Student-Class
 - Uses service-role `supabase` for inserts (trusted)
 - Inserts per-row with logging to surface exact errors
------------------------------*/
async function ensureScoresForStudentClass(client, studentClassId, classId) {
  try {
    // get grading items for that class
    const { data: items, error: itemErr } = await client
      .from("gradingitems")
      .select("id")
      .eq("class_id", classId);

    if (itemErr) {
      console.error("[ensureScores] failed to load gradingitems for class", classId, itemErr);
      return;
    }
    if (!items || items.length === 0) {
      // nothing to create
      // console.log(`[ensureScores] no grading items for class ${classId}`);
      return;
    }

    // find existing scores for this student_class
    const { data: existingScores, error: existingErr } = await client
      .from("score")
      .select("grading_item_id")
      .eq("student_class_id", studentClassId);

    if (existingErr) {
      console.error("[ensureScores] failed to load existing scores for student_class", studentClassId, existingErr);
      return;
    }

    const existing = new Set(existingScores?.map(s => s.grading_item_id) || []);

    // create missing rows only (insert one-by-one so we can log precise failures)
    const rowsToInsert = items
      .filter(item => !existing.has(item.id))
      .map(item => ({
        student_class_id: studentClassId,
        grading_item_id: item.id,
        score: null, // empty by default (your schema allows NULL)
      }));

    if (rowsToInsert.length === 0) {
      // nothing to insert
      // console.log(`[ensureScores] nothing to insert for student_class ${studentClassId}`);
      return;
    }

    for (const row of rowsToInsert) {
      // insert row-by-row to expose FK / unique errors precisely
      const { data: inserted, error: insertErr } = await client
        .from("score")
        .insert(row)
        .select();

      if (insertErr) {
        console.error("[ensureScores] insert failed for row:", row, insertErr);
        // continue trying other rows instead of aborting; adjust if you prefer to throw
      } else {
        // optional: log inserted row id(s)
        // console.log("[ensureScores] inserted score row:", inserted);
      }
    }

  } catch (err) {
    console.error("[ensureScores] unexpected error:", err);
  }
}


/* ------------------------------
Middleware: Require Auth
------------------------------ */
function requireAuth(req, res, next) {
  const token = req.cookies["supabase-auth-token"];
  if (!token) return res.redirect("/login");

  supabase.auth.getUser(token).then(({ data: { user }, error }) => {
    if (error || !user) return res.redirect("/login");
    req.user = user;
    next();
  });
}

/* ------------------------------
LOGIN
------------------------------ */
app.get("/", (req, res) => res.render("login"));
app.get("/login", (req, res) => res.render("login"));

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return res.render("login", { error: error.message });
  }

  res.cookie("supabase-auth-token", data.session.access_token, {
    httpOnly: true,
  });

  res.redirect("/home");
});

/* ------------------------------
HOME
------------------------------ */
app.get("/home", requireAuth, (req, res) => res.render("home"));

/* ------------------------------
VIEW STUDENTS
------------------------------ */
app.get("/views", requireAuth, async (req, res) => {
  const token = req.cookies["supabase-auth-token"];
  const supabaseClient = supabaseUser(token);

  const { data: students, error } = await supabaseClient
    .from("student")
    .select(
      `id,
      name,
      age,
      status,
      student_classes (
        classes ( id, name, order_index )
      )`
    );

  if (error) {
    console.error("Supabase query error:", error);
    return res.send("Database error");
  }

  res.render("views", { students });
});

/* ------------------------------
ADD STUDENT FORM
------------------------------ */
app.get("/add-student", requireAuth, async (req, res) => {
  const token = req.cookies["supabase-auth-token"];
  const supabaseClient = supabaseUser(token);

  const { data: classes, error } = await supabaseClient
    .from("classes")
    .select("*")
    .order("name");

  if (error) return res.send("Database error");

  res.render("addStudent", { classes });
});

/* ------------------------------
SUBMIT NEW STUDENT + CLASSES
------------------------------ */
app.post("/submit", requireAuth, async (req, res) => {
  const token = req.cookies["supabase-auth-token"];
  const supabaseClient = supabaseUser(token);

  const { name, age, parent_name, contact } = req.body;

  const rawIds = req.body.class_id?.split(",") || [];
  const rawLabels = req.body.class_label?.split(",") || [];
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  let finalClassIds = [];

  for (let i = 0; i < rawIds.length; i++) {
    const id = rawIds[i];
    const label = rawLabels[i];

    if (uuidRegex.test(id)) {
      finalClassIds.push(id);
    } else {
      const { data: newClass, error: classErr } = await supabaseClient
        .from("classes")
        .insert({ name: label })
        .select()
        .single();

      if (classErr) {
        console.error("Error creating class:", classErr);
        return res.status(500).send("Failed to create new class");
      }

      finalClassIds.push(newClass.id);
    }
  }

  const { data: student, error: studentErr } = await supabase
    .from("student")
    .insert({
      name,
      age: Number(age),
      contactname: parent_name,
      contactnumber: contact,
    })
    .select()
    .single();

  if (studentErr) {
    console.error("Error inserting student:", studentErr);
    return res.status(500).send("Failed to add student");
  }

  const classLinks = finalClassIds.map((cid) => ({
    student_id: student.id,
    class_id: cid,
  }));

  // insert and get the new student_classes rows (so we have their ids)
  const { data: studentClasses, error: linkErr } = await supabase
    .from("student_classes")
    .insert(classLinks)
    .select();

  if (linkErr) {
    console.error("Error linking classes:", linkErr);
    return res.status(500).send("Failed to link classes");
  }

  // Debugging: show created student_classes
  console.log("[/submit] studentClasses created:", studentClasses);

  /* ------------------------------
  PREPOPULATE SCORE TABLE
   - using service-role client `supabase` for trusted inserts
  ------------------------------ */
  for (const sc of studentClasses) {
    console.log("[/submit] prepopulating for student_class:", sc.id, "class:", sc.class_id);
    await ensureScoresForStudentClass(supabase, sc.id, sc.class_id);
  }

  res.redirect("/views");
});

/* ------------------------------
SEARCH
------------------------------ */
app.get("/search-students", requireAuth, async (req, res) => {
  const token = req.cookies["supabase-auth-token"];
  const supabaseClient = supabaseUser(token);

  const q = req.query.q?.toLowerCase() || "";

  let { data: students, error } = await supabaseClient
    .from("student")
    .select(
      `id,
      name,
      age,
      contactname,
      contactnumber,
      student_classes!inner (
        classes!inner (id, name, order_index)
      )`
    )
    .or(`name.ilike.%${q}%`)
    .order("id", { ascending: false });

  if (!error && q) {
    students = students.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.student_classes.some((sc) =>
          sc.classes.name.toLowerCase().includes(q)
        )
    );
  }

  if (error) return res.status(500).json({ error: "Database error" });

  res.render("rows/studentRows", { students });
});

/* ------------------------------
EDIT STUDENT
------------------------------ */
app.get("/edit-student/:id", requireAuth, async (req, res) => {
  const token = req.cookies["supabase-auth-token"];
  const supabaseClient = supabaseUser(token);
  const studentId = req.params.id;

  const { data: student, error: studentErr } = await supabaseClient
    .from("student")
    .select(
      `id,
      name,
      age,
      contactname,
      contactnumber,
      status,
      student_classes (
        id,
        class_id,
        classes ( id, name, order_index )
      )`
    )
    .eq("id", studentId)
    .single();

  if (studentErr || !student)
    return res.status(404).send("Student not found");

  const { data: classes, error: classErr } = await supabaseClient
    .from("classes")
    .select("*")
    .order("order_index");

  if (classErr) return res.status(500).send("Failed to load classes");

  res.render("editStudent", { student, classes });
});

/* ------------------------------
UPDATE STUDENT
------------------------------ */
app.post("/edit-student/:id", requireAuth, async (req, res) => {
  const token = req.cookies["supabase-auth-token"];
  const supabaseClient = supabaseUser(token);

  const studentId = req.params.id;
  const { name, age, parent_name, contact, class_id } = req.body;

  /* ======================
     1. UPDATE STUDENT INFO
     ====================== */
  const { error: studentErr } = await supabaseClient
    .from("student")
    .update({
      name,
      age: Number(age),
      contactname: parent_name,
      contactnumber: contact,
    })
    .eq("id", studentId);

  if (studentErr) {
    console.error("Failed to update student:", studentErr);
    return res.status(500).send("Failed to update student");
  }

  /* ======================
     2. PARSE INCOMING CLASSES
     ====================== */
  const classIds = class_id
    ? class_id.split(",").map(id => id.trim()).filter(Boolean)
    : [];

  /* ======================
     3. FETCH EXISTING CLASSES
     ====================== */
  const { data: existing, error: fetchErr } = await supabase
    .from("student_classes")
    .select("id, class_id")
    .eq("student_id", studentId);

  if (fetchErr) {
    console.error(fetchErr);
    return res.status(500).send("Failed to fetch student classes");
  }

  const existingClassIds = existing.map(e => e.class_id);

  /* ======================
     4. DIFF (DELETE / INSERT)
     ====================== */
  const toDelete = existing.filter(e => !classIds.includes(e.class_id));
  const toInsert = classIds.filter(cid => !existingClassIds.includes(cid));

  /* ======================
     5. DELETE REMOVED CLASSES
     ====================== */
  if (toDelete.length > 0) {
    const ids = toDelete.map(e => e.id);

    const { error: deleteErr } = await supabase
      .from("student_classes")
      .delete()
      .in("id", ids);

    if (deleteErr) {
      console.error("Failed to delete student_classes:", deleteErr);
      return res.status(500).send("Failed to remove classes");
    }
  }

  /* ======================
     6. INSERT NEW CLASSES
     ====================== */
  if (toInsert.length > 0) {
    const rows = toInsert.map(cid => ({
      student_id: studentId,
      class_id: cid,
    }));

    const { data: inserted, error: insertErr } = await supabase
      .from("student_classes")
      .insert(rows)
      .select();

    if (insertErr) {
      console.error("Failed to insert student_classes:", insertErr);
      return res.status(500).send("Failed to add classes");
    }

    // Prepopulate scores ONLY for new classes
    for (const sc of inserted) {
      await ensureScoresForStudentClass(supabase, sc.id, sc.class_id);
    }
  }

  /* ======================
     7. DONE
     ====================== */
  res.redirect("/views");
});

/* ------------------------------
UPDATE STATUS
------------------------------ */
app.post("/update-status/:id", requireAuth, async (req, res) => {
  const studentId = req.params.id;
  const { status } = req.body;

  if (!status) return res.status(400).json({ error: "Missing status" });

  const { error } = await supabase
    .from("student")
    .update({ status })
    .eq("id", studentId);

  if (error) return res.status(500).json({ error: "Database update failed" });

  res.json({ success: true });
});

app.listen(port, () =>
  console.log(`Server running at http://localhost:${port}`)
);

/* ------------------------------
GRADING PAGE
------------------------------ */
app.get("/scores", requireAuth, async (req, res) => {
  try {
    const token = req.cookies["supabase-auth-token"];
    const client = supabaseUser(token);

    const { data: classes, error } = await client
      .from("classes")
      .select("*")
      .order("order_index");

    if (error) throw error;

    res.render("grading", { classes });
  } catch (err) {
    console.error("GET /scores error:", err);
    res.status(500).send("Server error");
  }
});

/* -----------------------------------------------
GRADING: SELECT STUDENT WITHIN CLASS
----------------------------------------------- */
app.get("/scores/:classId", requireAuth, async (req, res) => {
  const { classId } = req.params;

  try {
    const token = req.cookies["supabase-auth-token"];
    const client = supabaseUser(token);

    // get class
    const { data: cls, error: classErr } = await client
      .from("classes")
      .select("*")
      .eq("id", classId)
      .single();

    if (classErr) throw classErr;
    
    // get students for class
   const { data: students, error: studErr } = await client
      .from("student_classes")
      .select(`
        id,
        student:student_id (
          id,
          name,
          age,
          contactname,
          contactnumber
        )
      `)
      .eq("class_id", classId);

    if (studErr) throw studErr;

    // Sort students by name
    students.sort((a, b) => a.student.name.localeCompare(b.student.name));

    res.render("grading-class", {
      cls,
      students,
      classId,
    });
  } catch (err) {
    console.error("GET /scores/:classId error:", err);
    res.status(500).send("Error loading grading page");
  }
});

/*-----------------------------------
RENDER SCORE TABLE
------------------------------------- */

app.get("/scores/:classId/student/:studentId", requireAuth, async (req, res) => {
  const { classId, studentId } = req.params;

  try {
    const token = req.cookies["supabase-auth-token"]
    const client = supabaseUser(token);

    // get student_class_id
    const { data: sc, error: scErr } = await client
      .from("student_classes")
      .select("id")
      .eq("class_id", classId)
      .eq("student_id", studentId)
      .single();

    if (scErr) throw scErr;

    const studentClassId = sc.id;

      const { data: scnotes, error: notesErr } = await client
      .from("student_classes")
      .select("note")
      .eq("id", studentClassId)
      .single();

    if (notesErr) throw notesErr;

    const existingNote = scnotes?.note || "";

    // get all grading items for this class
    const { data: items, error: itemsErr } = await client
      .from("gradingitems")
      .select("*")
      .eq("class_id", classId)
      .order("order_index");

    if (itemsErr) throw itemsErr;

    // get existing scores
    const { data: scores, error: scoreErr } = await client
      .from("score")
      .select("*")
      .eq("student_class_id", studentClassId);

    if (scoreErr) throw scoreErr;

    // attach scores to items
    const scoreMap = {};
    scores.forEach(s => {
      scoreMap[s.grading_item_id] = s;
    });

    const withScores = items.map(item => ({
      ...item,
      score_id: scoreMap[item.id]?.id || null,
      score_value: scoreMap[item.id]?.score || null
    }));

    // group by category
    const categoriesMap = {};
    for (const item of withScores) {
      if (!categoriesMap[item.category]) {
        categoriesMap[item.category] = [];
      }
      categoriesMap[item.category].push(item);
    }

    const categories = Object.keys(categoriesMap).map(c => ({
      category_name: c,
      items: categoriesMap[c]
    }));

    res.render("rows/scoring-table", {
      categories,
      classId,
      studentId,
      studentClassId,
      existingNote
    });

  } catch (err) {
    console.error("GET score table error:", err);
    res.status(500).send("Error loading score table");
  }
});

app.post("/save-score", requireAuth, async (req, res) => {
  const { scoreId, itemId, studentClassId, score } = req.body;

  try {
    // Use UPSERT for unique (student_class_id, grading_item_id)
    const { data, error } = await supabase
      .from("score")
      .upsert({
        id: scoreId || undefined,
        grading_item_id: itemId,
        student_class_id: studentClassId,
        score: score,
        updated_at: new Date()
      }, {
        onConflict: "student_class_id, grading_item_id"
      })
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("Save score error:", err);
    res.status(500).json({ error: "Failed to save score" });
  }
});

app.post("/save-notes", requireAuth, async (req, res) => {
  const { studentClassId, note } = req.body;

  try {
    const token = req.cookies["supabase-auth-token"];
    const client = supabaseUser(token);

    const { error } = await client
      .from("student_classes")
      .update({ note })
      .eq("id", studentClassId);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error("Error saving notes:", err);
    res.status(500).json({ error: "Failed to save notes" });
  }
});

/*--------------------------------------
EXPORT TO PDF
----------------------------------------*/
function renderView(app, view, data) {
  return new Promise((resolve, reject) => {
    app.render(view, data, (err, html) => {
      if (err) reject(err);
      else resolve(html);
    });
  });
}
app.get("/export-pdf/:studentClassId", async (req, res) => {
  let browser;

  const logoPath = path.join(process.cwd(), "public", "image", "logo.png");
  const logoBase64 = fs.readFileSync(logoPath, { encoding: "base64" });
    const fontRegular = fs.readFileSync(
      path.join(process.cwd(), "public", "fonts", "ComicSans-Regular.ttf"),
      "base64"
    );

    const fontBold = fs.readFileSync(
      path.join(process.cwd(), "public", "fonts", "ComicSans-Bold.ttf"),
      "base64"
    );

    const fontItalic = fs.readFileSync(
      path.join(process.cwd(), "public", "fonts", "ComicSans-Italic.ttf"),
      "base64"
    );

    const fontBoldItalic = fs.readFileSync(
      path.join(process.cwd(), "public", "fonts", "ComicSans-BoldItalic.ttf"),
      "base64"
    );

  try {
    const { studentClassId } = req.params;

    // ----------------------------------------
    // 1️⃣ Fetch student + class
    // ----------------------------------------
    const { data: sc, error: scErr } = await supabase
      .from("student_classes")
      .select(`
        id,
        note,
        student:student_id (
          id,
          name,
          age,
          contactname,
          contactnumber,
          createdate
        ),
        class:class_id (
          id,
          name
        )
      `)
      .eq("id", studentClassId)
      .maybeSingle();

    if (scErr || !sc) {
      console.error(scErr);
      return res.status(404).send("Student not found");
    }

    // ----------------------------------------
    // 2️⃣ Fetch grading items
    // ----------------------------------------
    const { data: gradingItems, error: itemErr } = await supabase
      .from("gradingitems")
      .select("id, category, subcategory, order_index")
      .eq("class_id", sc.class.id)
      .order("order_index", { ascending: true });

    if (itemErr) {
      console.error(itemErr);
      return res.status(500).send("Failed to load grading items");
    }

    // ----------------------------------------
    // 3️⃣ Fetch scores
    // ----------------------------------------
    const { data: scores, error: scoreErr } = await supabase
      .from("score")
      .select("grading_item_id, score")
      .eq("student_class_id", studentClassId);

    if (scoreErr) {
      console.error(scoreErr);
      return res.status(500).send("Failed to load scores");
    }

    // ----------------------------------------
    // 4️⃣ Merge item + score
    // ----------------------------------------
    const grouped = {};

    for (const item of gradingItems) {
      const found = scores.find(s => s.grading_item_id === item.id);

      const merged = {
        ...item,
        score: found?.score ?? null
      };

      if (!grouped[item.category]) grouped[item.category] = [];
      grouped[item.category].push(merged);
    }

    // ----------------------------------------
    // 5️⃣ Render HTML (EJS → string)
    // ----------------------------------------
    const html = await renderView(req.app, "report-card", {
      student: sc.student,
      classInfo: sc.class,
      categories: grouped,
      note: sc.note ?? "",
      logoBase64,
      fontRegular,
      fontBold,
      fontItalic,
      fontBoldItalic
    });

    // ----------------------------------------
    // 6️⃣ Launch Puppeteer (local or Vercel)
    // ----------------------------------------
    const isVercel = !!process.env.AWS_REGION;


    if (isVercel) {
      // VERCEL → puppeteer-core + chromium
      const chromium = (await import("@sparticuz/chromium")).default;
      const puppeteer = (await import("puppeteer-core")).default;

      browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
      });
    } else {
      // LOCAL → full puppeteer (bundled Chrome)
      const puppeteer = (await import("puppeteer")).default;
      browser = await puppeteer.launch({ headless: true });
    }

    // ----------------------------------------
    // 7️⃣ Generate PDF
    // ----------------------------------------
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" })
    await page.evaluateHandle('document.fonts.ready');

    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true
    });

    await browser.close();

    // ----------------------------------------
    // 8️⃣ Send PDF
    // ----------------------------------------
    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename=${sc.student.name}-report.pdf`
    });

    res.send(pdfBuffer);

  } catch (err) {
    console.error(err);

    if (browser) {
      try { await browser.close(); } catch (e) {}
    }

    res.status(500).send("Failed to generate PDF");
  }
});

