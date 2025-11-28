import express from "express";
import bodyParser from "body-parser";
import { supabase } from "./db.js";
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

function requireAuth(req, res, next) {
  const token = req.cookies['supabase-auth-token'];

  if (!token) {
    return res.redirect('/login'); // Not logged in
  }

  // Optionally verify token with Supabase
  supabase.auth.getUser(token).then(({ data: { user }, error }) => {
    if (error || !user) {
      return res.redirect('/login');
    }
    req.user = user; // attach user info to request
    next();
  });
}

app.get('/', (req, res) => {
  res.render('login');
});

app.get("/login", async (req, res) => {
  res.render('login');
})

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  
  if (error) {
    return res.render("login", { error: error.message });
  }
  res.cookie("supabase-auth-token", data.session.access_token, { httpOnly: true });
  res.redirect("/home");
});

app.get("/home", requireAuth, async (req, res) => {
  res.render('home');
})

app.get("/views", requireAuth, async (req, res) => {
  const { data: students, error } = await supabase
    .from("Student")
    .select("*")
    .order("id", { ascending: false });

  if (error) {
    console.error("Supabase query error:", error);
    return res.send("Database error");
  }

  res.render("views", { students });
});

app.get("/add-student",requireAuth, async (req, res) => {
    res.render('addStudent');
  })

app.post("/submit", async (req, res) => {
  const { name, age, class: className, parent_name, contact } = req.body;

  const { data, error } = await supabase
    .from("Student")
    .insert([
      {
        name,
        age: Number(age),
        class: className,
        contactName: parent_name,
        contactNumber: Number(contact)
      }
    ]);

  if (error) {
    console.error("Error inserting student:", error);
    return res.status(500).send("Failed to add student");
  }

  console.log("Inserted student:", data);

  res.redirect("/views");
});

app.get("/search-students", async (req, res) => {
  const searchQuery = req.query.q || "";

  const { data: students, error } = await supabase
    .from("Student")
    .select("*")
    .or(`name.ilike.%${searchQuery}%,class.ilike.%${searchQuery}%`)
    .order("id", { ascending: false });

  if (error) {
    console.error(error);
    return res.status(500).json({ error: "Database error" });
  }

  res.render("rows/studentRows", { students });
});

app.get("/edit-student/:id", requireAuth, async (req, res) => {
  const studentId = req.params.id;

  const { data: student, error } = await supabase
    .from("Student")
    .select("*")
    .eq("id", studentId)
    .single();

  if (error || !student) {
    console.error(error);
    return res.status(404).send("Student not found");
  }

  res.render("editStudent", { student });
});

app.post("/edit-student/:id", requireAuth, async (req, res) => {
  const studentId = req.params.id;
  const { name, age, class: className, parent_name, contact } = req.body;

  const { error } = await supabase
    .from("Student")
    .update({
      name,
      age: Number(age),
      class: className,
      contactName: parent_name,
      contactNumber: Number(contact)
    })
    .eq("id", studentId);

  if (error) {
    console.error(error);
    return res.status(500).send("Failed to update student");
  }

  res.redirect("/views");
});

app.post("/update-status/:id", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ error: "Missing status value." });
  }

  const { error } = await supabase
    .from("Student")
    .update({ status })
    .eq("id", id);

  if (error) {
    console.error("Supabase error:", error);
    return res.status(500).json({ error: "Failed to update status." });
  }

  res.json({ success: true });
});

app.listen(port, () =>
  console.log(`Server running at http://localhost:${port}`)
);
