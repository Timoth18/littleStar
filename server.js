import express from "express";
import bodyParser from "body-parser";
import { supabase } from "./db.js";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const port = 3000;


app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static("public"));
app.set("view engine", "ejs");

app.get('/', (req, res) => {
  res.render('login');
});

app.get("/login", async (req, res) => {
  res.render('login');
})

app.get("/home", async (req, res) => {
  res.render('home');
})

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // Stay on login page and show error
    return res.render("login", { error: error.message });
  }

  // Login succeeded, redirect to /home
  res.redirect("/home");
});

app.get("/views", async (req, res) => {
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

app.get("/add-student", async (req, res) => {
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

  res.json(students);
});

app.listen(port, () =>
  console.log(`Server running at http://localhost:${port}`)
);
