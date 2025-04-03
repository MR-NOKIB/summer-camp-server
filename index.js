const express = require("express");
const cors = require("cors");
const jwt = require('jsonwebtoken');
require('dotenv').config()
const app = express();
const port = process.env.PORT || 5000;
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// middleware
app.use(express.json());
app.use(cors({
    origin: ['http://localhost:5173', 'https://summer-camp-7e938.web.app'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true
}));


// Define middleware functions first
const verifyToken = (req, res, next) => {
    if (!req.headers.authorization) {
        return res.status(401).send({ message: 'Unauthorized Access' })
    }
    const token = req.headers.authorization.split(' ')[1];
    jwt.verify(token, process.env.ACCESS_TOKEN, (err, decoded) => {
        if (err) {
            return res.status(401).send({ message: 'Unauthorized Access' })
        }
        req.decoded = decoded;
        next();
    })
};

// mongodb connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.ekr4n.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        await client.connect();

        // These collections are declared but we'll access them directly in the route handlers outside this function
        // const userCollection = client.db("summer-camp").collection("users")
        // const classCollection = client.db("summer-camp").collection("classes");
        // const instructorCollection = client.db("summer-camp").collection("instructors");
        // const cartCollection = client.db("summer-camp").collection("cart");
        // const paymentHistoryCollection = client.db("summer-camp").collection("paymentHistory");

        // Middleware functions are kept here for reference, but they won't work properly outside the run() function context
        // We've reimplemented their functionality directly in the route handlers

        // Send a ping to confirm a successful connection
        await client.db("admin").command({ ping: 1 });
        console.log("Pinged your deployment. You successfully connected to MongoDB!");
    } finally {
        // await client.close();
    }
}

run().catch(console.dir);

// JWT endpoint
app.post("/jwt", async (req, res) => {
    const user = req.body;
    const token = jwt.sign(user, process.env.ACCESS_TOKEN, { expiresIn: '1h' });
    res.send({ token });
});

// Payment-related endpoints
app.post('/create-checkout-session', async (req, res) => {
    const { price, email, name, cartItems } = req.body;
    
    if (!price || isNaN(price) || price <= 0 || !email || !name || !cartItems) {
        return res.status(400).send({ error: 'Missing required fields' });
    }

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            line_items: [
                {
                    price_data: {
                        currency: 'usd',
                        unit_amount: Math.round(price * 100),
                        product_data: {
                            name: 'Summer Camp Registration',
                        },
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            success_url: 'http://localhost:5173/success',
            cancel_url: 'http://localhost:5173/cancel',
            metadata: {
                email: email,
                name: name,
                cartItems: JSON.stringify(cartItems)
            }
        });

        const db = client.db("summer-camp");
        const paymentHistoryCollection = db.collection("paymentHistory");
        
        const paymentData = {
            email,
            name,
            totalPrice: price,
            transactionId: session.id,
            cartItems,
            status: 'pending',
            createdAt: new Date(),
            paymentDate: null
        };

        await paymentHistoryCollection.insertOne(paymentData);
        res.json({ url: session.url });
    } catch (error) {
        console.error(error);
        res.status(500).send({ error: error.message });
    }
});

// Webhook endpoint
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(
            req.body,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        console.error(`Webhook Error: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        
        const db = client.db("summer-camp");
        const paymentHistoryCollection = db.collection("paymentHistory");
        const cartCollection = db.collection("cart");
        
        await paymentHistoryCollection.updateOne(
            { transactionId: session.id },
            {
                $set: {
                    status: 'completed',
                    paymentDate: new Date()
                }
            }
        );

        const metadata = session.metadata;
        if (metadata && metadata.email) {
            await cartCollection.deleteMany({ email: metadata.email });
        }
    }

    res.json({ received: true });
});

// Payment history endpoint
app.get('/payment-history/:email', verifyToken, async (req, res) => {
    try {
        const email = req.params.email;
        if (email !== req.decoded.email) {
            return res.status(403).send({ message: 'unauthorized access' });
        }

        const db = client.db("summer-camp");
        const paymentHistoryCollection = db.collection("paymentHistory");
        const query = { email: email };
        const result = await paymentHistoryCollection.find(query).sort({ createdAt: -1 }).toArray();
        res.send(result);
    } catch (error) {
        console.error("Error fetching payment history:", error);
        res.status(500).send({ error: "Failed to fetch payment history" });
    }
});

// Get all payments (admin only)
app.get('/all-payments', verifyToken, async (req, res) => {
    try {
        // Check if user is admin
        const email = req.decoded.email;
        const db = client.db("summer-camp");
        const userCollection = db.collection("users");
        const paymentHistoryCollection = db.collection("paymentHistory");
        
        const user = await userCollection.findOne({ email });
        if (!user || user.role !== 'admin') {
            return res.status(403).send({ message: 'Forbidden access: Admin only' });
        }
        
        const result = await paymentHistoryCollection.find().sort({ createdAt: -1 }).toArray();
        res.send(result);
    } catch (error) {
        console.error("Error fetching all payments:", error);
        res.status(500).send({ error: error.message });
    }
});

// User-related endpoints
app.get("/users", verifyToken, async (req, res) => {
    try {
        // Check if user is admin
        const email = req.decoded.email;
        const db = client.db("summer-camp");
        const userCollection = db.collection("users");
        
        const user = await userCollection.findOne({ email });
        if (!user || user.role !== 'admin') {
            return res.status(403).send({ message: 'Forbidden access: Admin only' });
        }
        
        const result = await userCollection.find().toArray();
        res.send(result);
    } catch (error) {
        console.error("Error fetching users:", error);
        res.status(500).send({ error: "Failed to fetch users" });
    }
});

// Verify Admin
app.get("/users/admin/:email", verifyToken, async (req, res) => {
    try {
        const email = req.params.email;
        if (email !== req.decoded.email) {
            return res.status(403).send({ message: 'unauthorized access' });
        }
        
        const db = client.db("summer-camp");
        const userCollection = db.collection("users");
        const query = { email: email };
        const user = await userCollection.findOne(query);
        let admin = false;
        if (user) {
            admin = user?.role === 'admin';
        }
        res.send({ admin });
    } catch (error) {
        console.error("Error checking admin status:", error);
        res.status(500).send({ error: "Failed to check admin status" });
    }
});

// Verify Instructor
app.get("/users/instructor/:email", verifyToken, async (req, res) => {
    try {
        const email = req.params.email;
        if (email !== req.decoded.email) {
            return res.status(403).send({ message: 'unauthorized access' });
        }

        const db = client.db("summer-camp");
        const userCollection = db.collection("users");
        const query = { email: email };
        const user = await userCollection.findOne(query);
        let instructor = false;
        if (user) {
            instructor = user?.role === 'instructor';
        }
        res.send({ instructor });
    } catch (error) {
        console.error("Error checking instructor status:", error);
        res.status(500).send({ error: "Failed to check instructor status" });
    }
});

// Add new user
app.post("/users", async (req, res) => {
    try {
        const user = req.body;
        const db = client.db("summer-camp");
        const userCollection = db.collection("users");
        const query = { email: user.email };
        const existingUser = await userCollection.findOne(query);
        if (existingUser) {
            return res.send({ message: 'user already exist', insertedId: null });
        }
        const result = await userCollection.insertOne(user);
        res.send(result);
    } catch (error) {
        console.error("Error adding user:", error);
        res.status(500).send({ error: "Failed to add user" });
    }
});

// Delete user
app.delete("/users/:id", verifyToken, async (req, res) => {
    try {
        // Check if user is admin
        const email = req.decoded.email;
        const db = client.db("summer-camp");
        const userCollection = db.collection("users");
        
        const user = await userCollection.findOne({ email });
        if (!user || user.role !== 'admin') {
            return res.status(403).send({ message: 'Forbidden access: Admin only' });
        }
        
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await userCollection.deleteOne(query);
        res.send(result);
    } catch (error) {
        console.error("Error deleting user:", error);
        res.status(500).send({ error: "Failed to delete user" });
    }
});

// Make user admin
app.patch('/users/admin/:id', verifyToken, async (req, res) => {
    try {
        // Check if user is admin
        const email = req.decoded.email;
        const db = client.db("summer-camp");
        const userCollection = db.collection("users");
        
        const currentUser = await userCollection.findOne({ email });
        if (!currentUser || currentUser.role !== 'admin') {
            return res.status(403).send({ message: 'Forbidden access: Admin only' });
        }
        
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const updatedDoc = {
            $set: {
                role: 'admin',
            }
        };
        const result = await userCollection.updateOne(filter, updatedDoc);
        res.send(result);
    } catch (error) {
        console.error("Error making user admin:", error);
        res.status(500).send({ error: "Failed to update user role" });
    }
});

// Make user instructor
app.patch('/users/instructor/:id', verifyToken, async (req, res) => {
    try {
        // Check if user is admin
        const email = req.decoded.email;
        const db = client.db("summer-camp");
        const userCollection = db.collection("users");
        
        const currentUser = await userCollection.findOne({ email });
        if (!currentUser || currentUser.role !== 'admin') {
            return res.status(403).send({ message: 'Forbidden access: Admin only' });
        }
        
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const updatedDoc = {
            $set: {
                role: 'instructor',
            }
        };
        const result = await userCollection.updateOne(filter, updatedDoc);
        res.send(result);
    } catch (error) {
        console.error("Error making user instructor:", error);
        res.status(500).send({ error: "Failed to update user role" });
    }
});

// Update payment status (admin only)
app.patch('/payment-status/:id', verifyToken, async (req, res) => {
    try {
        // Check if user is admin
        const email = req.decoded.email;
        const db = client.db("summer-camp");
        const userCollection = db.collection("users");
        const paymentHistoryCollection = db.collection("paymentHistory");
        
        const user = await userCollection.findOne({ email });
        if (!user || user.role !== 'admin') {
            return res.status(403).send({ message: 'Forbidden access: Admin only' });
        }
        
        const { id } = req.params;
        const { status } = req.body;
        
        const result = await paymentHistoryCollection.updateOne(
            { _id: new ObjectId(id) },
            { 
                $set: { 
                    status,
                    paymentDate: status === 'completed' ? new Date() : null
                } 
            }
        );
        
        if (result.modifiedCount > 0) {
            res.send({ success: true });
        } else {
            res.status(404).send({ error: 'Payment not found' });
        }
    } catch (error) {
        console.error("Error updating payment status:", error);
        res.status(500).send({ error: error.message });
    }
});

// routes
app.get("/", (req, res) => {
    res.send("Hello World");
});

// This is where we'll handle the /classes route outside of run() function
app.get("/classes/:limit?", async (req, res) => {
    try {
        const db = client.db("summer-camp");
        const classCollection = db.collection("classes");
        
        let query = {};
        const limit = req.params.limit;
        if (limit) {
            query = { price: { $lt: 250 } }
        } 
        else if (req.query.email) {
            query = { email: req.query.email }
        }
        
        const result = await classCollection.find(query).toArray();
        res.send(result);
    } catch (error) {
        console.error("Error fetching classes:", error);
        res.status(500).send({ error: "Failed to fetch classes" });
    }
});

// Handle class creation
app.post("/classes", async (req, res) => {
    try {
        // First verify if user has proper rights
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).send({ message: 'Unauthorized Access' });
        }
        
        // Verify the token
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.ACCESS_TOKEN);
        } catch (err) {
            return res.status(401).send({ message: 'Unauthorized Access' });
        }
        
        // Get the user to check role
        const db = client.db("summer-camp");
        const userCollection = db.collection("users");
        const classCollection = db.collection("classes");
        
        const email = decoded.email;
        const user = await userCollection.findOne({ email });
        
        if (!user || (user.role !== 'admin' && user.role !== 'instructor')) {
            return res.status(403).send({ message: 'Forbidden access: Admins or instructors only' });
        }
        
        // User has proper rights, proceed with adding the class
        const classData = req.body;
        const result = await classCollection.insertOne(classData);
        res.send(result);
    } catch (error) {
        console.error("Error creating class:", error);
        res.status(500).send({ error: "Failed to create class" });
    }
});

// Handle class deletion
app.delete("/classes/:id", async (req, res) => {
    try {
        // First verify if user has proper rights
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) {
            return res.status(401).send({ message: 'Unauthorized Access' });
        }
        
        // Verify the token
        let decoded;
        try {
            decoded = jwt.verify(token, process.env.ACCESS_TOKEN);
        } catch (err) {
            return res.status(401).send({ message: 'Unauthorized Access' });
        }
        
        // Get the user to check role
        const db = client.db("summer-camp");
        const userCollection = db.collection("users");
        const classCollection = db.collection("classes");
        
        const email = decoded.email;
        const user = await userCollection.findOne({ email });
        
        if (!user || user.role !== 'admin') {
            return res.status(403).send({ message: 'Forbidden access: Admin only' });
        }
        
        // User has proper rights, proceed with deleting the class
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await classCollection.deleteOne(query);
        res.send(result);
    } catch (error) {
        console.error("Error deleting class:", error);
        res.status(500).send({ error: "Failed to delete class" });
    }
});

// Instructors endpoint
app.get("/instructors", async (req, res) => {
    try {
        const db = client.db("summer-camp");
        const instructorCollection = db.collection("instructors");
        const result = await instructorCollection.find().toArray();
        res.send(result);
    } catch (error) {
        console.error("Error fetching instructors:", error);
        res.status(500).send({ error: "Failed to fetch instructors" });
    }
});

// Cart related endpoints
app.get("/carts", async (req, res) => {
    try {
        const email = req.query.email;
        if (!email) {
            return res.status(400).send({ error: "Email parameter is required" });
        }
        
        const db = client.db("summer-camp");
        const cartCollection = db.collection("cart");
        const query = { email: email };
        const result = await cartCollection.find(query).toArray();
        res.send(result);
    } catch (error) {
        console.error("Error fetching cart:", error);
        res.status(500).send({ error: "Failed to fetch cart items" });
    }
});

app.post("/carts", async (req, res) => {
    try {
        const cartClasses = req.body;
        const db = client.db("summer-camp");
        const cartCollection = db.collection("cart");
        const result = await cartCollection.insertOne(cartClasses);
        res.send(result);
    } catch (error) {
        console.error("Error adding to cart:", error);
        res.status(500).send({ error: "Failed to add to cart" });
    }
});

app.delete('/carts/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const db = client.db("summer-camp");
        const cartCollection = db.collection("cart");
        const query = { _id: new ObjectId(id) };
        const result = await cartCollection.deleteOne(query);
        res.send(result);
    } catch (error) {
        console.error("Error removing from cart:", error);
        res.status(500).send({ error: "Failed to remove from cart" });
    }
});

app.delete('/carts/clear/:email', async (req, res) => {
    try {
        const email = req.params.email;
        const db = client.db("summer-camp");
        const cartCollection = db.collection("cart");
        const query = { email: email };
        const result = await cartCollection.deleteMany(query);
        res.send({ 
            success: true, 
            deletedCount: result.deletedCount 
        });
    } catch (error) {
        console.error('Error clearing cart:', error);
        res.status(500).send({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`Summer Camp Server is running on port ${port}`);
});

