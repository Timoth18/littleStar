import express from "express";
import bodyParser from "body-parser";
import { supabase, supabaseUser } from "./db.js"; // supabase = service role
import dotenv from "dotenv";
import cookieParser from "cookie-parser";

dotenv.config();

const app = express();
const port = 3000;

app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static("public"));
app.use(express.json());
app.use(cookieParser());
app.set("view engine", "ejs");

// Middleware to require logged-in users
function requireAuth(req, res, next) {
  const token = req.cookies['supabase-auth-token'];

  if (!token) {
    return res.redirect('/login'); // Not logged in
  }

  // Verify user with Supabase
  supabase.auth.getUser(token).then(({ data: { user }, error }) => {
    if (error || !user) {
      return res.redirect('/login');
    }
    req.user = user; // attach user info to request
    next();
  });
}

// Login routes
app.get('/', (req, res) => res.render('login'));
app.get("/login", async (req, res) => res.render('login'));

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  
  if (error) return res.render("login", { error: error.message });

  res.cookie("supabase-auth-token", data.session.access_token, { httpOnly: true });
  res.redirect("/home");
});

// Home
app.get("/home", requireAuth, async (req, res) => {
  res.render('home');
});

// View students
app.get("/views", requireAuth, async (req, res) => {
  const token = req.cookies['supabase-auth-token'];
  const supabaseClient = supabaseUser(token); // role-based client

  const { data: students, error } = await supabaseClient
    .from('Student')
    .select(`
      id,
      name,
      age,  
      StudentClasses (
        Classes ( id, name, order_index )
      )
    `);

  if (error) {
    console.error("Supabase query error:", error);
    return res.send("Database error");
  }

  res.render("views", { students });
});

// Add student form
app.get("/add-student", requireAuth, async (req, res) => {
  const token = req.cookies['supabase-auth-token'];
  const supabaseClient = supabaseUser(token);

  const { data: classes, error } = await supabaseClient
    .from("Classes")
    .select("*")
    .order("name", { ascending: true });

  if (error) {
    console.error("Supabase query error:", error);
    return res.send("Database error");
  }

  res.render('addStudent', { classes });
});

// Submit student + classes
app.post("/submit", requireAuth, async (req, res) => {
  const token = req.cookies['supabase-auth-token'];
  const supabaseClient = supabaseUser(token);

  const { name, age, parent_name, contact } = req.body;

  // Arrays from hidden inputs
  const rawIds = req.body.class_id?.split(",") || [];
  const rawLabels = req.body.class_label?.split(",") || [];
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  let finalClassIds = [];

  // Create new classes if needed
  for (let i = 0; i < rawIds.length; i++) {
    const id = rawIds[i];
    const label = rawLabels[i];

    if (uuidRegex.test(id)) {
      finalClassIds.push(id); // existing class
    } else {
      // Create new class (role-based insert)
      const { data: newClass, error: classErr } = await supabaseClient
        .from("Classes")
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

  // Insert student (trusted server insert)
  const { data: student, error: studentErr } = await supabase
    .from("Student")
    .insert({
      name,
      age: Number(age),
      contactname: parent_name,
      contactnumber: contact
    })
    .select()
    .single();

  if (studentErr) {
    console.error("Error inserting student:", studentErr);
    return res.status(500).send("Failed to add student");
  }

  // Link student to classes (trusted server insert)
  const classLinks = finalClassIds.map(cid => ({
    student_id: student.id,
    class_id: cid
  }));

  const { error: linkErr } = await supabase
    .from("StudentClasses")
    .insert(classLinks);

  if (linkErr) {
    console.error("Error linking classes:", linkErr);
    return res.status(500).send("Failed to link classes");
  }

  res.redirect("/views");
});

// Search students
app.get("/search-students", requireAuth, async (req, res) => {
  const token = req.cookies['supabase-auth-token'];
  const supabaseClient = supabaseUser(token);

  const q = req.query.q || "";

  let { data: students, error } = await supabaseClient
    .from("Student")
    .select(`
      id,
      name,
      age,
      contactname,
      contactnumber,
      StudentClasses!inner (
        Classes!inner (id, name, order_index)
      )
    `)
    .or(`name.ilike.%${q}%`)
    .order("id", { ascending: false });

  if (!error && q) {
    const lower = q.toLowerCase();
    students = students.filter(s =>
      s.name.toLowerCase().includes(lower) ||
      s.StudentClasses.some(sc =>
        sc.Classes.name.toLowerCase().includes(lower)
      )
    );
  }

  if (error) {
    console.error("Search error:", error);
    return res.status(500).json({ error: "Database error" });
  }

  res.render("rows/studentRows", { students });
});

// Edit student
app.get("/edit-student/:id", requireAuth, async (req, res) => {
  const token = req.cookies['supabase-auth-token'];
  const supabaseClient = supabaseUser(token);

  const studentId = req.params.id;

  const { data: student, error: studentErr } = await supabaseClient
    .from("Student")
    .select(`
      id,
      name,
      age,
      contactname,
      contactnumber,
      status,
      StudentClasses (
        id,
        class_id,
        Classes ( id, name, order_index )
      )
    `)
    .eq("id", studentId)
    .single();

  if (studentErr || !student) {
    console.error("Failed to fetch student:", studentErr);
    return res.status(404).send("Student not found");
  }

  const { data: classes, error: classErr } = await supabaseClient
    .from("Classes")
    .select("*")
    .order("order_index", { ascending: true });

  if (classErr) {
    console.error("Failed to fetch classes:", classErr);
    return res.status(500).send("Failed to load classes");
  }

  res.render("editStudent", { student, classes });
});

// Update student
app.post("/edit-student/:id", requireAuth, async (req, res) => {
  const token = req.cookies['supabase-auth-token'];
  const supabaseClient = supabaseUser(token);

  const studentId = req.params.id;
  const { name, age, parent_name, contact, class_id } = req.body;

  // Update student
  const { error: studentErr } = await supabaseClient
    .from("Student")
    .update({
      name,
      age: Number(age),
      contactname: parent_name,
      contactnumber: contact
    })
    .eq("id", studentId);

  if (studentErr) {
    console.error(studentErr);
    return res.status(500).send("Failed to update student");
  }

  // Update StudentClasses
  await supabase
    .from("StudentClasses")
    .delete()
    .eq("student_id", studentId);

  if (class_id && class_id.trim() !== "") {
    await supabase
      .from("StudentClasses")
      .insert({
        student_id: studentId,
        class_id
      });
  }

  res.redirect("/views");
});

app.listen(port, () =>
  console.log(`Server running at http://localhost:${port}`)
);
